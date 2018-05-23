/*!
 * nodes.js - merklix tree nodes
 * Copyright (c) 2018, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

/* eslint no-use-before-define: "off" */

'use strict';

const assert = require('assert');
const common = require('./common');
const {hashInternal} = common;

/*
 * Constants
 */

const NULL = 0;
const INTERNAL = 1;
const LEAF = 2;
const HASH = 3;

const types = {
  NULL,
  INTERNAL,
  LEAF,
  HASH
};

const typesByVal = [
  'NULL',
  'INTERNAL',
  'LEAF',
  'HASH'
];

/**
 * Node
 */

class Node {
  constructor(type) {
    this.type = type;
    this.index = 0;
    this.pos = 0;
  }

  hash(ctx) {
    return ctx.constructor.zero;
  }

  getSize(hash, bits) {
    return this.constructor.getSize(hash, bits);
  }

  write(data, off, ctx, hash, bits) {
    throw new Error('Unimplemented.');
  }

  encode(ctx, hash, bits) {
    const size = Internal.getSize(hash, bits);
    const data = Buffer.allocUnsafe(size);
    this.write(data, 0, ctx, hash, bits);
    return data;
  }

  decode(data, hash, bits) {
    throw new Error('Unimplemented.');
  }

  async getLeft(store) {
    throw new Error('Unimplemented.');
  }

  async getRight(store) {
    throw new Error('Unimplemented.');
  }

  async getValue(store) {
    throw new Error('Unimplemented.');
  }

  async resolve(store) {
    return this;
  }

  static decode(data, hash, bits) {
    return new this().decode(data, hash, bits);
  }

  isNull() {
    return this.type === NULL;
  }

  isInternal() {
    return this.type === INTERNAL;
  }

  isLeaf() {
    return this.type === LEAF;
  }

  isHash() {
    return this.type === HASH;
  }

  static getSize(hash, bits) {
    throw new Error('Unimplemented.');
  }
}

/**
 * Null
 */

class Null extends Node {
  constructor(type) {
    super(NULL);
  }

  inspect() {
    return '<NIL>';
  }
}

/**
 * Internal
 */

class Internal extends Node {
  constructor(left, right) {
    super(INTERNAL);

    // Not serialized.
    this.data = null;
    this.index = 0;
    this.pos = 0;
    this.gen = 0;

    this.left = left || exports.NIL;
    this.right = right || exports.NIL;
  }

  hash(ctx) {
    if (!this.data) {
      const left = this.left.hash(ctx);
      const right = this.right.hash(ctx);

      this.data = hashInternal(ctx, left, right);
    }

    return this.data;
  }

  write(data, off, ctx, hash, bits) {
    const left = this.left.hash(ctx);
    const right = this.right.hash(ctx);

    data[off] = INTERNAL;
    off += 1;

    off += left.copy(data, off);
    off = data.writeUInt16LE(this.left.index, off);
    off = data.writeUInt32LE(this.left.pos, off);

    off += right.copy(data, off);
    off = data.writeUInt16LE(this.right.index, off);
    off = data.writeUInt32LE(this.right.pos, off);

    return off;
  }

  decode(data, hash, bits) {
    const nodeSize = Internal.getSize(hash, bits);

    assert(data.length === nodeSize);
    assert(data[0] === INTERNAL);

    let off = 1;

    const left = data.slice(off, off + hash.size);
    off += hash.size;

    if (!left.equals(hash.zero)) {
      const leftIndex = data.readUInt16LE(off, true);
      off += 2;

      const leftPos = data.readUInt32LE(off, true);
      off += 4;

      this.left = new Hash(left, leftIndex, leftPos);
    } else {
      off += 2 + 4;
    }

    const right = data.slice(off, off + hash.size);
    off += hash.size;

    if (!right.equals(hash.zero)) {
      const rightIndex = data.readUInt16LE(off, true);
      off += 2;

      const rightPos = data.readUInt32LE(off, true);
      off += 4;

      this.right = new Hash(right, rightIndex, rightPos);
    } else {
      off += 2 + 4;
    }

    return this;
  }

  async getLeft(store) {
    if (this.left.type === HASH)
      this.left = await this.left.resolve(store);

    return this.left;
  }

  async getRight(store) {
    if (this.right.type === HASH)
      this.right = await this.right.resolve(store);

    return this.right;
  }

  inspect() {
    return {
      left: this.left.inspect(),
      right: this.right.inspect()
    };
  }

  static getSize(hash, bits) {
    assert(hash && typeof hash.digest === 'function');
    assert((bits >>> 0) === bits);
    assert(bits > 0 && (bits & 7) === 0);
    return 1 + (hash.size + 2 + 4) * 2;
  }
}

/**
 * Leaf
 */

class Leaf extends Node {
  constructor(leaf, key, value) {
    super(LEAF);

    // Not serialized.
    this.index = 0;
    this.pos = 0;
    this.value = value || null;

    this.data = leaf || null;
    this.key = key || null;
    this.vindex = 0;
    this.vpos = 0;
    this.vsize = 0;
  }

  hash() {
    assert(this.data);
    return this.data;
  }

  write(data, off, ctx, hash, bits) {
    const leafSize = Leaf.getSize(hash, bits);
    const nodeSize = Internal.getSize(hash, bits);
    const left = nodeSize - leafSize;

    data[off] = LEAF;
    off += 1;

    off += this.data.copy(data, off);
    off += this.key.copy(data, off);

    off = data.writeUInt16LE(this.vindex, off, true);
    off = data.writeUInt32LE(this.vpos, off, true);
    off = data.writeUInt32LE(this.vsize, off, true);

    data.fill(0x00, off, off + left);
    off += left;

    return off;
  }

  decode(data, hash, bits) {
    const nodeSize = Internal.getSize(hash, bits);

    assert(data.length === nodeSize);
    assert(data[0] === LEAF);

    let off = 1;

    this.data = data.slice(off, off + hash.size);
    off += hash.size;

    this.key = data.slice(off, off + (bits >>> 3));
    off += bits >>> 3;

    this.vindex = data.readUInt16LE(off, true);
    off += 2;

    this.vpos = data.readUInt32LE(off, true);
    off += 4;

    this.vsize = data.readUInt32LE(off, true);
    off += 4;

    return this;
  }

  async getValue(store) {
    if (!this.value) {
      const {vindex, vpos, vsize} = this;
      this.value = await store.read(vindex, vpos, vsize);
    }

    return this.value;
  }

  inspect() {
    return `<Leaf: ${this.key.toString('hex')}>`;
  }

  static getSize(hash, bits) {
    assert(hash && typeof hash.digest === 'function');
    assert((bits >>> 0) === bits);
    assert(bits > 0 && (bits & 7) === 0);
    return 1 + hash.size + (bits >>> 3) + 2 + 4 + 4;
  }
}

/**
 * Hash
 */

class Hash extends Node {
  constructor(hash, index, pos) {
    super(HASH);
    this.data = hash || null;
    this.index = index || 0;
    this.pos = pos || 0;
  }

  hash(ctx) {
    assert(this.data);
    return this.data;
  }

  async resolve(store) {
    const node = await store.readNode(this.index, this.pos);
    node.data = this.data;
    return node;
  }

  inspect() {
    return `<Hash: ${this.data.toString('hex')}>`;
  }
}

/*
 * Helpers
 */

function decodeNode(data, hash, bits, index, pos) {
  let node;

  assert(data.length > 0);

  switch (data[0]) {
    case INTERNAL:
      node = Internal.decode(data, hash, bits);
      break;
    case LEAF:
      node = Leaf.decode(data, hash, bits);
      break;
    default:
      throw new Error('Database corruption.');
  }

  node.index = index;
  node.pos = pos;

  return node;
}

/*
 * Expose
 */

exports.types = types;
exports.typesByVal = typesByVal;
exports.NIL = new Null();
exports.Node = Node;
exports.Null = Null;
exports.Internal = Internal;
exports.Leaf = Leaf;
exports.Hash = Hash;
exports.decodeNode = decodeNode;