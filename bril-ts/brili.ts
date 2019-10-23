#!/usr/bin/env node
import * as bril from './bril';
import {readStdin, unreachable} from './util';
import { isConstructSignatureDeclaration, isConstructorDeclaration } from 'typescript';

/*
 * We're doing fixed array size of 4 so set this here
 * It's all my computer support natively so don't go beyond
 */
let fixedVecSize: number = 4;

const argCounts: {[key in bril.OpCode]: number | null} = {
  add: 2,
  mul: 2,
  sub: 2,
  div: 2,
  id: 1,
  lt: 2,
  le: 2,
  gt: 2,
  ge: 2,
  eq: 2,
  not: 1,
  and: 2,
  or: 2,
  print: null,  // Any number of arguments.
  br: 3,
  jmp: 1,
  ret: 0,
  nop: 0,
  lw: 1,
  sw: 2,
  vadd: 2,
  vload: 1,
  vstore: 2,
  s2v: fixedVecSize, // set scalars to vector produce vector reg
  s2vb: 1, // broadcast scalar reg to fill each value of scalar reg
  v2s: 2, // get value from vector reg to scalar reg
  vcmp: 2, // compare two vector registers and write to results to pred register
  idv: 1,
  vphi: 3, // join two predicate paths
  phi: null, // join any number of control flow paths
  vmul: 2,
  vsub: 2,
  vdiv: 2,
  gather: 1,
  scatter: 2
};

// this represents an infinite size register file
type Env = Map<bril.Ident, bril.Value>;

/*
 * Declare an array of memory to represent a stack-like memory structure.
 * Locations of memory dictated by software and freed if ever change stack frame/function
 * The freeing isn't supported yet because there is only one function
 */
let stackSize: number = 24576;
let stack = new Int32Array(stackSize);

/*
 * Initialize the binding
 */

function get(env: Env, ident: bril.Ident) {
  let val = env.get(ident);
  if (typeof val === 'undefined') {
    throw `undefined variable ${ident}`;
  }
  return val;
}

/**
 * Ensure that the instruction has exactly `count` arguments,
 * throwing an exception otherwise.
 */
function checkArgs(instr: bril.Operation, count: number) {
  if (instr.args.length != count) {
    throw `${instr.op} takes ${count} argument(s); got ${instr.args.length}`;
  }
}

function getInt(instr: bril.Operation, env: Env, index: number) {
  let val = get(env, instr.args[index]);
  if (typeof val !== 'number') {
    throw `${instr.op} argument ${index} must be a number`;
  }
  return val;
}

function getBool(instr: bril.Operation, env: Env, index: number) {
  let val = get(env, instr.args[index]);
  if (typeof val !== 'boolean') {
    throw `${instr.op} argument ${index} must be a boolean`;
  }
  return val;
}

// memory lookup
function getMem(addr: number) {
  if (addr < stackSize) {
    let val = stack[addr];
    return val;
  }
  else {
    throw `load with addr ${addr} out of range of stack`;
  }
}

// memory write
function setMem(val: number, addr: number) {
  if (addr < stackSize) {
    stack[addr] = val;
  }
  else {
    throw `store addr ${addr} out of range of stack`;
  }
}

// get vector value from vector register file
function getVec(instr: bril.Operation, env: Env, index: number) {
  let val = get(env, instr.args[index]);
  if (!(val instanceof Int32Array)) {
    throw `${instr.op} argument ${index} must be a Int32Array`;
  }

  return val;
}

// get predicate value from predicate register file
function getPred(instr: bril.ValueOperation, env: Env, index?: number) {
  if (index !== undefined) {
    let val = get(env, instr.args[index]);
    if (!Array.isArray(val) || !val.every(item => typeof item === "boolean")) {
      throw `${instr.op} pred argument must be an Boolean Array`;
    }
    return val;
  }

  if (instr.pred === undefined || instr.pred === "undefined") {
    let noMask = new Array<boolean>(fixedVecSize);
    for (let i = 0; i < fixedVecSize; i++) {
      noMask[i] = true;
    }
    return noMask;
  }

  let val = get(env, instr.pred);
  if (!Array.isArray(val) || !val.every(item => typeof item === "boolean")) {
    throw `${instr.op} pred argument must be an Boolean Array`;
  }

  // if the mask is negative we need to invert each signal
  if (instr.neg == "1") {
    // careful about pass by ref, deep copy here
    let negVal = new Array<boolean>(fixedVecSize);
    for (let i = 0; i < fixedVecSize; i++) {
      negVal[i] = !val[i];
    }
    return negVal
  }
  else {
    return val;
  }
}



/**
 * The thing to do after interpreting an instruction: either transfer
 * control to a label, go to the next instruction, or end thefunction.
 */
type Action =
  {"label": bril.Ident} |
  {"next": true} |
  {"end": true};
let NEXT: Action = {"next": true};
let END: Action = {"end": true};

/**
 * Interpret an instruction in a given environment, possibly updating the
 * environment. If the instruction branches to a new label, return that label;
 * otherwise, return "next" to indicate that we should proceed to the next
 * instruction or "end" to terminate the function.
 */
function evalInstr(instr: bril.Instruction, env: Env): Action {
  // Check that we have the right number of arguments.
  if (instr.op !== "const") {
    let count = argCounts[instr.op];
    if (count === undefined) {
      throw "unknown opcode " + instr.op;
    } else if (count !== null) {
      checkArgs(instr, count);
    }
  }

  switch (instr.op) {
  case "const":
    env.set(instr.dest, instr.value);
    return NEXT;

  case "id": {
    let val = get(env, instr.args[0]);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "add": {
    let val = getInt(instr, env, 0) + getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "mul": {
    let val = getInt(instr, env, 0) * getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "sub": {
    let val = getInt(instr, env, 0) - getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "div": {
    let val = getInt(instr, env, 0) / getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "le": {
    let val = getInt(instr, env, 0) <= getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "lt": {
    let val = getInt(instr, env, 0) < getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "gt": {
    let val = getInt(instr, env, 0) > getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "ge": {
    let val = getInt(instr, env, 0) >= getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "eq": {
    let val = getInt(instr, env, 0) === getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "not": {
    let val = !getBool(instr, env, 0);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "and": {
    let val = getBool(instr, env, 0) && getBool(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "or": {
    let val = getBool(instr, env, 0) || getBool(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "print": {
    let values = instr.args.map(i => get(env, i));
    console.log(...values);
    return NEXT;
  }

  case "jmp": {
    return {"label": instr.args[0]};
  }

  case "br": {
    let cond = getBool(instr, env, 0);
    if (cond) {
      return {"label": instr.args[1]};
    } else {
      return {"label": instr.args[2]};
    }
  }
  
  case "ret": {
    return END;
  }

  case "nop": {
    return NEXT;
  }


  case "lw": {
    // lookup memory based on value in register
    let addr = getInt(instr, env, 0);
    let val = getMem(addr);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "sw": {
    let val = getInt(instr, env, 0);
    let addr = getInt(instr, env, 1);
    setMem(val, addr);
    return NEXT;
  }

  case "vadd": {

    // serialized version
    let vecA = getVec(instr, env, 0);
    let vecB = getVec(instr, env, 1);
    let vecC = new Int32Array(fixedVecSize);

    // if there's a predicate need to skip lanes
    let mask = getPred(instr, env);

    for (let i = 0; i < fixedVecSize; i++) {
      if (mask[i]) {
        vecC[i] = vecA[i] + vecB[i];
      }
    }
    env.set(instr.dest, vecC);    

    return NEXT;
  }

  case "vload": {

    // serialized version
    let addr = getInt(instr, env, 0);
    let vec = new Int32Array(fixedVecSize);
    for (let i = 0; i < fixedVecSize; i++) {
      vec[i] = getMem(addr + i);
    }
    env.set(instr.dest, vec);
    return NEXT;
  }

  case "gather": {
    let addrs = getVec(instr, env, 0);
    let vec = new Int32Array(fixedVecSize);
    for (let i = 0; i < fixedVecSize; i++) {
      vec[i] = getMem(addrs[i]);
    }
    env.set(instr.dest, vec);
    return NEXT;
  }

  case "vstore": {
    
    // serialized version
    let val = getVec(instr, env, 0);
    let addr = getInt(instr, env, 1);
    for (let i = 0; i < fixedVecSize; i++) {
      setMem(val[i], addr + i);
    }

    return NEXT;
  }

  case "scatter": {
    let val = getVec(instr, env, 0);
    let addrs = getVec(instr, env, 1);
    for (let i = 0; i < fixedVecSize; i++) {
      setMem(val[i], addrs[i]);
    }

    return NEXT;
  }

  case "s2v": {
    let vector = new Int32Array(fixedVecSize);
    for (let i = 0; i < fixedVecSize; i++) {
      vector[i] = getInt(instr, env, i);
    }
    env.set(instr.dest, vector);

    return NEXT;
  }

  case "s2vb": {
    let scalar = getInt(instr, env, 0);
    let vector = new Int32Array(fixedVecSize);
    for (let i = 0; i < fixedVecSize; i++) {
      vector[i] = scalar;
    }
    env.set(instr.dest, vector);    

    return NEXT;
  }

  case "v2s": {
    let vector = getVec(instr, env, 0);
    let idx    = getInt(instr, env, 1);
    env.set(instr.dest, vector[idx]);

    return NEXT;
  }

  case "vcmp": {
    let vec0 = getVec(instr, env, 0);
    let vec1 = getVec(instr, env, 1);
    let pred = new Array<boolean>(fixedVecSize);
    for (let i = 0; i < fixedVecSize; i++) {
      pred[i] = vec0[i] == vec1[i];
    }
    env.set(instr.dest, pred);

    return NEXT;
  }

  case "idv": {
    let vec0 = getVec(instr, env, 0);
    let vec1 = new Int32Array(fixedVecSize);

    // if there's a predicate need to skip lanes
    let mask = getPred(instr, env);

    for (let i = 0; i < fixedVecSize; i++) {
      if (mask[i]) {
        vec1[i] = vec0[i];
      }
    }
    env.set(instr.dest, vec1);

    return NEXT;
  }

  case "vphi": {
    let mask = getPred(instr, env, 0);
    let vec0 = getVec(instr, env, 1);
    let vec1 = getVec(instr, env, 2);
    let vec2 = new Int32Array(fixedVecSize);
    for (let i = 0; i < fixedVecSize; i++) {
      if (mask[i]) {
        vec2[i] = vec0[i];
      }
      else {
        vec2[i] = vec1[i];
      }
    }
    env.set(instr.dest, vec2);

    return NEXT;
  }

  case "phi": {
    // check which path was last executed and choose the value from that
    // an easy hack (in ssa) is to just check which variable is currently defined in the interpeter
    let idx = 0;
    for (let i = 0; i < instr.args.length; i++) {
      if (env.get(instr.args[i]) !== undefined) {
        idx = i;
      }
    }

    // the value that exists is the one that gets passed to dest reg
    let val = getInt(instr, env, idx);
    env.set(instr.dest, val);

    return NEXT;
  }

  case "vmul": {
    let vecA = getVec(instr, env, 0);
    let vecB = getVec(instr, env, 1);
    let vecC = new Int32Array(fixedVecSize);
    let mask = getPred(instr, env);
    for (let i = 0; i < fixedVecSize; i++) {
      if (mask[i]) {
        vecC[i] = vecA[i] * vecB[i];
      }
    }
    env.set(instr.dest, vecC);    

    return NEXT;
  }

  case "vsub": {
    let vecA = getVec(instr, env, 0);
    let vecB = getVec(instr, env, 1);
    let vecC = new Int32Array(fixedVecSize);
    let mask = getPred(instr, env);
    for (let i = 0; i < fixedVecSize; i++) {
      if (mask[i]) {
        vecC[i] = vecA[i] - vecB[i];
      }
    }
    env.set(instr.dest, vecC);    

    return NEXT;
  }

  case "vdiv": {
    let vecA = getVec(instr, env, 0);
    let vecB = getVec(instr, env, 1);
    let vecC = new Int32Array(fixedVecSize);
    let mask = getPred(instr, env);
    for (let i = 0; i < fixedVecSize; i++) {
      if (mask[i]) {
        vecC[i] = vecA[i] / vecB[i];
      }
    }
    env.set(instr.dest, vecC);    

    return NEXT;
  }


  }
  unreachable(instr);
  throw `unhandled opcode ${(instr as any).op}`;
}

function evalFunc(func: bril.Function) {
  let env: Env = new Map();
  for (let i = 0; i < func.instrs.length; ++i) {
    let line = func.instrs[i];
    if ('op' in line) {
      let action = evalInstr(line, env);

      if ('label' in action) {
        // Search for the label and transfer control.
        for (i = 0; i < func.instrs.length; ++i) {
          let sLine = func.instrs[i];
          if ('label' in sLine && sLine.label === action.label) {
            break;
          }
        }
        if (i === func.instrs.length) {
          throw `label ${action.label} not found`;
        }
      } else if ('end' in action) {
        return;
      }
    }
  }
}

function evalProg(prog: bril.Program) {
  for (let func of prog.functions) {
    if (func.name === "main") {
      evalFunc(func);
    }
  }
}

async function main() {
  let prog = JSON.parse(await readStdin()) as bril.Program;

  // time the execution here, b/c file io is picked up by python
  //console.time("brili");

  evalProg(prog);

  //console.timeEnd('brili');
}

// Make unhandled promise rejections terminate.
process.on('unhandledRejection', e => { throw e });

main();
