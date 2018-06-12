/*!
 * store.js - tree storage
 * Copyright (c) 2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/urkel
 */

'use strict';

const assert = require('assert');
const Path = require('path');
const fs = require('bfile');
const {Lock, MapLock} = require('bmutex');
const common = require('./common');
const errors = require('./errors');
const File = require('./file');
const MFS = require('./mfs');
const nodes = require('./nodes');

const {
  parseU32,
  serializeU32,
  EMPTY,
  randomPath,
  readU16,
  readU32,
  writeU16,
  writeU32
} = common;

const {
  AssertionError,
  MissingNodeError
} = errors;

const {
  decodeNode,
  NIL,
  Internal
} = nodes;

/*
 * Constants
 */

// Max read size on linux, and lower than off_t max
// (libuv will use a 32 bit off_t on 32 bit systems).
const MAX_FILE_SIZE = 0x7ffff000; // File max = 2 GB
const MAX_FILES = 0xffff; // DB max = 128 TB.
// const MAX_FILES = 0xffffff; // DB max = 32.768 PB.
// const MAX_FILES = 0xffffffff; // DB max = 8 EB.
const MAX_OPEN_FILES = 32;
const META_SIZE = 4 + 2 + 4 + 2 + 4 + 20;
const META_MAGIC = 0x6d726b6c;
const WRITE_BUFFER = 120 << 20;
const READ_BUFFER = 1 << 20;
const SLAB_SIZE = READ_BUFFER - (READ_BUFFER % META_SIZE);

/**
 * Store
 */

class Store {
  constructor(fs, prefix, hash, bits, standalone = true) {
    assert(fs && typeof fs.write === 'function');
    assert(typeof prefix === 'string');
    assert(hash && typeof hash.digest === 'function');
    assert((bits >>> 0) === bits);
    assert(bits > 0 && (bits & 7) === 0);
    assert(typeof standalone === 'boolean');

    this.fs = fs;
    this.prefix = prefix;
    this.hash = hash;
    this.bits = bits;
    this.standalone = standalone;
    this.nodeSize = Internal.getSize(hash, bits);
    this.openLock = MapLock.create();
    this.readLock = Lock.create();

    this.wb = new WriteBuffer();
    this.files = new FileMap();
    this.current = null;
    this.state = new Meta();
    this.index = 0;
    this.rootCache = new Map();
    this.lastMeta = new Meta();
  }

  path(index) {
    const name = serializeU32(index);
    return Path.resolve(this.prefix, name);
  }

  async readdir() {
    const names = await this.fs.readdir(this.prefix);
    const files = [];

    for (const name of names) {
      const index = parseU32(name);

      if (index === -1)
        continue;

      if (index === 0)
        continue;

      if (index > MAX_FILES)
        continue;

      const path = Path.resolve(this.prefix, name);
      const stat = await this.fs.lstat(path);

      if (!stat.isFile())
        continue;

      files.push({
        index,
        name,
        path,
        size: stat.size
      });
    }

    files.sort((a, b) => a.index - b.index);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (i > 0 && file.index !== files[i - 1].index + 1)
        throw new Error('Missing tree files.');
    }

    return files;
  }

  async stat() {
    const files = await this.readdir();

    let total = 0;

    for (const {size} of files)
      total += size;

    return {
      files: files.length,
      size: total
    };
  }

  async ensure() {
    if (this.index !== 0)
      throw new Error('Store already opened.');

    await this.fs.mkdirp(this.prefix, 0o750);

    const files = await this.readdir();

    if (files.length === 0)
      return 0;

    return files[files.length - 1].index;
  }

  async open() {
    if (this.index !== 0)
      throw new Error('Store already opened.');

    const index = await this.ensure();

    if (this.standalone) {
      const [state, meta] = await this.recoverState(index);
      this.state = state;
      this.index = state.metaIndex || 1;
      this.lastMeta = meta;
      this.current = await this.openFile(this.index, 'a+');
      this.start();
      this.state.rootNode = await this.getRoot();
    } else {
      this.index = index || 1;
      this.current = await this.openFile(this.index, 'a+');
      this.start();
    }
  }

  async close() {
    if (this.index === 0)
      throw new Error('Store already closed.');

    const files = this.files;

    this.wb = new WriteBuffer();
    this.files = new FileMap();
    this.current = null;
    this.state = new Meta();
    this.index = 0;
    this.rootCache.clear();
    this.lastMeta = new Meta();

    for (const file of files.values())
      await file.close();
  }

  async destroy() {
    if (this.index !== 0)
      throw new Error('Store is opened.');

    const files = await this.readdir();

    for (const {path} of files)
      await this.fs.unlink(path);

    try {
      await this.fs.rmdir(this.prefix);
    } catch (e) {
      if (e.code === 'ENOTEMPTY' || e.errno === -39) {
        const path = randomPath(this.prefix);
        return this.rename(path);
      }
      throw e;
    }

    return undefined;
  }

  async rename(prefix) {
    assert(typeof prefix === 'string');

    if (this.index !== 0)
      throw new Error('Store is opened.');

    await this.fs.rename(this.prefix, prefix);

    this.prefix = prefix;
  }

  async openFile(index, flags) {
    assert((index >>> 0) === index);
    assert(typeof flags === 'string');

    if (this.index === 0)
      throw new Error('Store is closed.');

    if (index === 0 || index > this.index + 1)
      throw new Error('Invalid file index.');

    const file = this.files.get(index);

    if (file)
      return file;

    return this.reallyOpen(index, flags);
  }

  async reallyOpen(index, flags) {
    const unlock = await this.openLock(index);
    try {
      return await this._reallyOpen(index, flags);
    } finally {
      unlock();
    }
  }

  async _reallyOpen(index, flags) {
    if (this.index === 0)
      throw new Error('Store is closed.');

    const cache = this.files.get(index);

    if (cache)
      return cache;

    const file = new File(this.fs, index);
    const path = this.path(index);

    await file.open(path, flags);

    // No race conditions.
    assert(!this.files.has(index));

    if (this.files.size >= MAX_OPEN_FILES)
      await this.evict();

    this.files.set(index, file);

    return file;
  }

  openFileSync(index, flags) {
    assert((index >>> 0) === index);
    assert(typeof flags === 'string');

    if (this.index === 0)
      throw new Error('Store is closed.');

    if (index === 0 || index > this.index + 1)
      throw new Error('Invalid file index.');

    const cache = this.files.get(index);

    if (cache)
      return cache;

    const file = new File(this.fs, index);
    const path = this.path(index);

    file.openSync(path, flags);

    if (this.files.size >= MAX_OPEN_FILES)
      this.evictSync();

    this.files.set(index, file);

    return file;
  }

  async closeFile(index) {
    assert((index >>> 0) === index);

    if (this.index === 0)
      throw new Error('Store is closed.');

    const file = this.files.get(index);

    if (!file)
      return undefined;

    if (file.reads > 0)
      return undefined;

    this.files.delete(index);

    return file.close();
  }

  closeFileSync(index) {
    assert((index >>> 0) === index);

    if (this.index === 0)
      throw new Error('Store is closed.');

    const file = this.files.get(index);

    if (!file)
      return;

    if (file.reads > 0)
      return;

    this.files.delete(index);

    file.closeSync();
  }

  evictIndex() {
    if (this.index === 0)
      throw new Error('Store is closed.');

    let total = 0;

    for (const [index, file] of this.files) {
      if (index === this.index)
        continue;

      if (file.reads > 0)
        continue;

      total += 1;
    }

    if (total === 0)
      return -1;

    let i = Math.random() * total | 0;

    for (const [index, file] of this.files) {
      if (index === this.index)
        continue;

      if (file.reads > 0)
        continue;

      if (i === 0)
        return index;

      i -= 1;
    }

    throw new AssertionError('Eviction index not found.');
  }

  async evict() {
    const index = this.evictIndex();

    if (index === -1)
      return undefined;

    return this.closeFile(index);
  }

  evictSync() {
    const index = this.evictIndex();

    if (index === -1)
      return;

    this.closeFileSync(index);
  }

  async read(index, pos, size) {
    if (this.index === 0)
      throw new Error('Store is closed.');

    const file = await this.openFile(index, 'r');

    return file.read(pos, size);
  }

  readSync(index, pos, size) {
    if (this.index === 0)
      throw new Error('Store is closed.');

    const file = this.openFileSync(index, 'r');

    return file.readSync(pos, size);
  }

  async write(data) {
    if (this.index === 0)
      throw new Error('Store is closed.');

    if (this.current.size + data.length > MAX_FILE_SIZE) {
      await this.current.sync();
      await this.closeFile(this.index);
      this.current = await this.openFile(this.index + 1, 'a+');
      this.index += 1;
    }

    return this.current.write(data);
  }

  async sync() {
    if (this.index === 0)
      throw new Error('Store is closed.');

    return this.current.sync();
  }

  async readNode(index, pos) {
    const data = await this.read(index, pos, this.nodeSize);
    return decodeNode(data, this.hash, this.bits, index, pos);
  }

  readNodeSync(index, pos) {
    const data = this.readSync(index, pos, this.nodeSize);
    return decodeNode(data, this.hash, this.bits, index, pos);
  }

  start() {
    assert(this.wb.written === 0);
    assert(this.wb.start === 0);
    this.wb.offset = this.current.size;
    this.wb.index = this.current.index;
    return this;
  }

  writeNull() {
    this.wb.expand(this.nodeSize);
    this.wb.pad(this.nodeSize);
  }

  writeNode(node) {
    assert(node.index === 0);

    this.wb.expand(this.nodeSize);

    const written = this.wb.written;

    node.write(
      this.wb.data,
      this.wb.written,
      this.hash,
      this.bits
    );

    this.wb.written += this.nodeSize;

    node.pos = this.wb.position(written);
    node.index = this.wb.index;

    return node.pos;
  }

  writeValue(node) {
    assert(node.isLeaf());
    assert(node.index === 0);
    node.vsize = node.value.length;
    node.vpos = this.wb.write(node.value);
    node.vindex = this.wb.index;
    return node.vpos;
  }

  needsFlush() {
    return this.wb.written >= WRITE_BUFFER;
  }

  async flush() {
    for (const chunk of this.wb.flush())
      await this.write(chunk);

    this.start();
  }

  async commit(root) {
    if (this.standalone)
      this.writeMeta();

    await this.flush();
    await this.sync();

    if (this.standalone) {
      const hash = root.hash(this.hash);

      if (!hash.equals(this.hash.zero)) {
        const key = hash.toString('hex');
        const node = root.toHash(this.hash);

        this.rootCache.set(key, node);

        this.state.rootNode = node;
      } else {
        this.state.rootNode = NIL;
      }
    }
  }

  writeMeta() {
    assert(this.standalone);

    if (this.wb.written < this.nodeSize)
      return;

    if (this.wb.written >= this.nodeSize) {
      this.state.rootIndex = this.wb.index;
      this.state.rootPos = this.wb.pos - this.nodeSize;
    }

    const padding = META_SIZE - (this.wb.pos % META_SIZE);

    this.wb.expand(padding + META_SIZE);
    this.wb.pad(padding);

    this.state.write(
      this.wb.data,
      this.wb.written,
      this.hash
    );

    this.wb.written += META_SIZE;

    this.state.metaIndex = this.wb.index;
    this.state.metaPos = this.wb.pos - META_SIZE;
  }

  parseMeta(data, off) {
    assert(this.standalone);
    try {
      return Meta.read(data, off, this.hash);
    } catch (e) {
      return null;
    }
  }

  async findMeta(file, slab) {
    assert(this.standalone);
    assert(file instanceof File);
    assert(Buffer.isBuffer(slab));

    let off = file.size - (file.size % META_SIZE);

    while (off >= META_SIZE) {
      let pos = 0;
      let size = off;

      if (off >= slab.length) {
        pos = off - slab.length;
        size = slab.length;
      }

      const data = await file.rawRead(pos, size, slab);

      while (size >= META_SIZE) {
        size -= META_SIZE;
        off -= META_SIZE;

        if (readU32(data, size) !== META_MAGIC)
          continue;

        const meta = this.parseMeta(data, size);

        if (meta) {
          await file.truncate(off + META_SIZE);
          return [off, meta];
        }
      }
    }

    return [-1, null];
  }

  async recoverState(index) {
    assert(this.standalone);
    assert((index >>> 0) === index);

    if (this.index !== 0)
      throw new Error('Store is open.');

    if (index === 0)
      return [new Meta(), new Meta()];

    const slab = Buffer.allocUnsafe(SLAB_SIZE);

    while (index >= 1) {
      const path = this.path(index);
      const file = new File(this.fs, index);

      let off = -1;
      let meta = null;

      await file.open(path, 'r+');

      try {
        [off, meta] = await this.findMeta(file, slab);
      } finally {
        await file.close();
      }

      if (meta) {
        const state = meta.clone();
        state.metaIndex = index;
        state.metaPos = off;

        return [state, meta];
      }

      await this.fs.unlink(path);

      index -= 1;
    }

    return [new Meta(), new Meta()];
  }

  async readMeta(index, pos) {
    assert(this.standalone);
    const data = await this.read(index, pos, META_SIZE);
    return Meta.decode(data, this.hash);
  }

  async getRootHash() {
    const root = await this.getRoot();
    return root.hash(this.hash);
  }

  async getRoot() {
    assert(this.standalone);

    if (this.index === 0)
      throw new Error('Store is closed.');

    if (this.state.rootNode)
      return this.state.rootNode;

    const {rootIndex, rootPos} = this.state;

    if (rootIndex === 0)
      return NIL;

    return this.readRoot(rootIndex, rootPos);
  }

  async readRoot(index, pos) {
    assert(this.standalone);

    const node = await this.readNode(index, pos);
    const hash = node.hash(this.hash);

    if (hash.equals(this.hash.zero))
      return node;

    const key = hash.toString('hex');

    if (!this.rootCache.has(key))
      this.rootCache.set(key, node.toHash(this.hash));

    return node;
  }

  async getHistory(rootHash) {
    assert(this.standalone);
    assert(Buffer.isBuffer(rootHash));

    if (this.index === 0)
      throw new Error('Store is closed.');

    if (rootHash.equals(this.hash.zero))
      return NIL;

    const key = rootHash.toString('hex');
    const cached = this.rootCache.get(key);

    if (cached)
      return cached;

    return this.readHistory(rootHash);
  }

  async readHistory(rootHash) {
    const unlock = await this.readLock();
    try {
      return await this._readHistory(rootHash);
    } finally {
      unlock();
    }
  }

  async _readHistory(rootHash) {
    assert(this.standalone);
    assert(Buffer.isBuffer(rootHash));

    if (this.index === 0)
      throw new Error('Store is closed.');

    let {metaIndex, metaPos} = this.lastMeta;

    for (;;) {
      if (metaIndex === 0) {
        throw new MissingNodeError({
          rootHash: rootHash,
          nodeHash: rootHash
        });
      }

      const meta = await this.readMeta(metaIndex, metaPos);
      const {rootIndex, rootPos} = meta;
      const node = await this.readRoot(rootIndex, rootPos);
      const hash = node.hash(this.hash);

      this.lastMeta = meta;

      if (hash.equals(rootHash))
        return node;

      metaIndex = meta.metaIndex;
      metaPos = meta.metaPos;
    }
  }
}

/**
 * Meta
 */

class Meta {
  constructor() {
    this.metaIndex = 0;
    this.metaPos = 0;
    this.rootIndex = 0;
    this.rootPos = 0;
    this.rootNode = null;
  }

  clone() {
    const meta = new this.constructor();
    meta.metaIndex = this.metaIndex;
    meta.metaPos = this.metaPos;
    meta.rootIndex = this.rootIndex;
    meta.rootPos = this.rootPos;
    meta.rootNode = this.rootNode;
    return meta;
  }

  getSize() {
    return this.constructor.getSize();
  }

  encode(hash, padding = 0) {
    assert((padding >>> 0) === padding);

    const data = Buffer.allocUnsafe(padding + META_SIZE);

    data.fill(0x00, 0, padding);

    this.write(data, padding, hash);

    return data;
  }

  write(data, off, hash) {
    assert(Buffer.isBuffer(data));
    assert((off >>> 0) === off);
    assert(hash && typeof hash.digest === 'function');
    assert(off + META_SIZE <= data.length);

    writeU32(data, META_MAGIC, off + 0, true);
    writeU16(data, this.metaIndex, off + 4, true);
    writeU32(data, this.metaPos, off + 6, true);
    writeU16(data, this.rootIndex, off + 10, true);
    writeU32(data, this.rootPos, off + 12, true);

    const preimage = data.slice(off, off + 16);
    const digest = hash.digest(preimage);

    assert(digest.length >= 20);

    digest.copy(data, off + 16, 0, 20);

    return off + META_SIZE;
  }

  decode(data, hash) {
    assert(Buffer.isBuffer(data));
    assert(data.length === META_SIZE);
    return this.read(data, 0, hash);
  }

  read(data, off, hash) {
    assert(Buffer.isBuffer(data));
    assert((off >>> 0) === off);
    assert(hash && typeof hash.digest === 'function');
    assert(off + META_SIZE <= data.length);

    const magic = readU32(data, off + 0);

    if (magic !== META_MAGIC)
      throw new Error('Invalid magic number.');

    const preimage = data.slice(off + 0, off + 16);
    const checksum = data.slice(off + 16, off + 16 + 20);
    const digest = hash.digest(preimage);

    assert(digest.length >= 20);

    const expect = digest.slice(0, 20);

    if (!checksum.equals(expect))
      throw new Error('Invalid metadata checksum.');

    this.metaIndex = readU16(data, off + 4);
    this.metaPos = readU32(data, off + 6);
    this.rootIndex = readU16(data, off + 10);
    this.rootPos = readU32(data, off + 12);

    return this;
  }

  static read(data, off, hash) {
    return new this().read(data, off, hash);
  }

  static decode(data, hash) {
    return new this().decode(data, hash);
  }

  static getSize() {
    return META_SIZE;
  }
}

/**
 * Write Buffer
 */

class WriteBuffer {
  constructor() {
    this.offset = 0;
    this.index = 0;
    this.start = 0;
    this.written = 0;
    this.chunks = [];
    this.data = EMPTY;
  }

  reset() {
    this.offset = 0;
    this.index = 0;
    this.start = 0;
    this.written = 0;
    this.chunks = [];
  }

  get pos() {
    return this.position(this.written);
  }

  position(written) {
    return this.offset + (written - this.start);
  }

  expand(size) {
    if (this.data.length === 0)
      this.data = Buffer.allocUnsafe(8192);

    while (this.written + size > this.data.length) {
      const buf = Buffer.allocUnsafe(this.data.length * 2);
      this.data.copy(buf, 0);
      this.data = buf;
    }

    if (this.position(this.written) + size > MAX_FILE_SIZE) {
      this.chunks.push(this.render());
      this.start = this.written;
      this.offset = 0;
      this.index += 1;
    }
  }

  write(data) {
    this.expand(data.length);

    const written = this.written;
    this.written += data.copy(this.data, this.written);

    return this.position(written);
  }

  pad(size) {
    this.data.fill(0x00, this.written, this.written + size);
    this.written += size;
  }

  render() {
    return this.data.slice(this.start, this.written);
  }

  flush() {
    const chunks = this.chunks;

    if (this.written > this.start)
      chunks.push(this.render());

    this.reset();

    return chunks;
  }
}

/**
 * File Map
 * Notion: a sparse array is faster than a hash table.
 */

class FileMap {
  constructor() {
    this.items = [];
    this.size = 0;
  }

  has(index) {
    return this.get(index) !== null;
  }

  get(index) {
    assert(index < MAX_FILES);

    if (index >= this.items.length)
      return null;

    const file = this.items[index];

    if (!file)
      return null;

    return file;
  }

  set(index, file) {
    assert(index < MAX_FILES);

    while (index >= this.items.length)
      this.items.push(null);

    if (!this.items[index])
      this.size += 1;

    this.items[index] = file;

    return this;
  }

  delete(index) {
    assert(index < MAX_FILES);

    if (index >= this.items.length)
      return false;

    if (this.items[index]) {
      this.items[index] = null;
      this.size -= 1;
      return true;
    }

    return false;
  }

  clear() {
    this.items.length = 0;
    this.size = 0;
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  *entries() {
    for (let i = 0; i < this.items.length; i++) {
      const file = this.items[i];

      if (file)
        yield [i, file];
    }
  }

  *keys() {
    for (let i = 0; i < this.items.length; i++) {
      const file = this.items[i];

      if (file)
        yield i;
    }
  }

  *values() {
    for (let i = 0; i < this.items.length; i++) {
      const file = this.items[i];

      if (file)
        yield file;
    }
  }
}

/**
 * File Store
 */

class FileStore extends Store {
  constructor(prefix, hash, bits, standalone) {
    super(fs, prefix, hash, bits, standalone);
  }
}

/**
 * Memory Store
 */

class MemoryStore extends Store {
  constructor(prefix, hash, bits, standalone) {
    super(new MFS(), prefix, hash, bits, standalone);
  }
}

/*
 * Expose
 */

exports.FileStore = FileStore;
exports.MemoryStore = MemoryStore;