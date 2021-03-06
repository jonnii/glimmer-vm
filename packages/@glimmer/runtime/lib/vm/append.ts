import { Register } from '../opcodes';
import { Scope, DynamicScope, Environment, Opcode, Handle, Heap } from '../environment';
import { ElementBuilder } from './element-builder';
import { Option, Destroyable, Stack, LinkedList, ListSlice, Opaque, expect, typePos } from '@glimmer/util';
import { ReferenceIterator, PathReference, VersionedPathReference, combineSlice } from '@glimmer/reference';
import { CompiledDynamicProgram } from '../compiled/blocks';
import { LabelOpcode, JumpIfNotModifiedOpcode, DidModifyOpcode } from '../compiled/opcodes/vm';
import { VMState, ListBlockOpcode, TryOpcode, BlockOpcode } from './update';
import RenderResult from './render-result';
import { DEBUG } from '@glimmer/local-debug-flags';

import {
  APPEND_OPCODES,
  UpdatingOpcode
} from '../opcodes';

import {
  Constants,
  ConstantString
} from '../environment/constants';

export interface PublicVM {
  env: Environment;
  dynamicScope(): DynamicScope;
  getSelf(): PathReference<Opaque>;
  newDestroyable(d: Destroyable): void;
}

export type CapturedStack = Opaque[];

export class EvaluationStack {
  static empty(): EvaluationStack {
    return new this([], 0, -1);
  }

  static restore(snapshot: CapturedStack): EvaluationStack {
    return new this(snapshot.slice(), 0, snapshot.length - 1);
  }

  constructor(private stack: Opaque[], public fp: number, public sp: number) {
    if (DEBUG) {
      Object.seal(this);
    }
  }

  isEmpty() {
    return this.sp === -1;
  }

  push(value: Opaque): void {
    this.stack[++this.sp] = value;
  }

  dup(position = this.sp): void {
    this.push(this.stack[position]);
  }

  pop<T>(n = 1): T {
    let top = this.stack[this.sp] as T;
    this.sp -= n;
    return top;
  }

  peek<T>(): T {
    return this.stack[this.sp] as T;
  }

  fromBase<T>(offset: number): T {
    return this.stack[this.fp - offset] as T;
  }

  fromTop<T>(offset: number): T {
    return this.stack[this.sp - offset] as T;
  }

  capture(items: number): CapturedStack {
    let end = this.sp + 1;
    let start = end - items;
    return this.stack.slice(start, end);
  }

  reset() {
    this.stack.length = 0;
  }

  toArray() {
    return this.stack.slice(this.fp, this.sp + 1);
  }
}

export type IteratorResult<T> = {
  done: false;
  value: null;
} | {
  done: true;
  value: T;
};

export default class VM implements PublicVM {
  private dynamicScopeStack = new Stack<DynamicScope>();
  private scopeStack = new Stack<Scope>();
  public updatingOpcodeStack = new Stack<LinkedList<UpdatingOpcode>>();
  public cacheGroups = new Stack<Option<UpdatingOpcode>>();
  public listBlockStack = new Stack<ListBlockOpcode>();
  public constants: Constants;
  public heap: Heap;

  public stack = EvaluationStack.empty();

  /* Registers */

  private pc = -1;
  private ra = -1;

  private get fp(): number {
    return this.stack.fp;
  }

  private set fp(fp: number) {
    this.stack.fp = fp;
  }

  private get sp(): number {
    return this.stack.sp;
  }

  private set sp(sp: number) {
    this.stack.sp = sp;
  }

  public s0: any = null;
  public s1: any = null;
  public t0: any = null;
  public t1: any = null;

  // Fetch a value from a register onto the stack
  fetch(register: Register) {
    this.stack.push(this[Register[register]]);
  }

  // Load a value from the stack into a register
  load(register: Register) {
    this[Register[register]] = this.stack.pop();
  }

  // Fetch a value from a register
  fetchValue<T>(register: Register): T {
    return this[Register[register]];
  }

  // Load a value into a register
  loadValue<T>(register: Register, value: T) {
    this[Register[register]] = value;
  }

  // Start a new frame and save $ra and $fp on the stack
  pushFrame() {
    this.stack.push(this.ra);
    this.stack.push(this.fp);
    this.fp = this.sp - 1;
  }

  // Restore $ra, $sp and $fp
  popFrame() {
    this.sp = this.fp - 1;
    this.ra = this.stack.fromBase<number>(0);
    this.fp = this.stack.fromBase<number>(-1);
  }

  // Jump to an address in `program`
  goto(offset: number) {
    this.pc = typePos(this.pc + offset);
  }

  // Save $pc into $ra, then jump to a new address in `program` (jal in MIPS)
  call(handle: Handle) {
    let pc = this.heap.getaddr(handle);
    this.ra = this.pc;
    this.pc = pc;
  }

  // Put a specific `program` address in $ra
  returnTo(offset: number) {
    this.ra = typePos(this.pc + offset);
  }

  // Return to the `program` address stored in $ra
  return() {
    this.pc = this.ra;
  }

  static initial(
    env: Environment,
    self: PathReference<Opaque>,
    dynamicScope: DynamicScope,
    elementStack: ElementBuilder,
    program: CompiledDynamicProgram
  ) {
    let scope = Scope.root(self, program.symbolTable.symbols.length);
    let vm = new VM(env, scope, dynamicScope, elementStack);
    vm.pc = vm.heap.getaddr(program.handle);
    vm.updatingOpcodeStack.push(new LinkedList<UpdatingOpcode>());
    return vm;
  }

  constructor(
    public env: Environment,
    scope: Scope,
    dynamicScope: DynamicScope,
    private elementStack: ElementBuilder,
  ) {
    this.env = env;
    this.heap = env.program.heap;
    this.constants = env.program.constants;
    this.elementStack = elementStack;
    this.scopeStack.push(scope);
    this.dynamicScopeStack.push(dynamicScope);
  }

  capture(args: number): VMState {
    return {
      dynamicScope: this.dynamicScope(),
      env: this.env,
      scope: this.scope(),
      stack: this.stack.capture(args)
    };
  }

  beginCacheGroup() {
    this.cacheGroups.push(this.updating().tail());
  }

  commitCacheGroup() {
    //        JumpIfNotModified(END)
    //        (head)
    //        (....)
    //        (tail)
    //        DidModify
    // END:   Noop

    let END = new LabelOpcode("END");

    let opcodes = this.updating();
    let marker = this.cacheGroups.pop();
    let head = marker ? opcodes.nextNode(marker) : opcodes.head();
    let tail = opcodes.tail();
    let tag = combineSlice(new ListSlice(head, tail));

    let guard = new JumpIfNotModifiedOpcode(tag, END);

    opcodes.insertBefore(guard, head);
    opcodes.append(new DidModifyOpcode(guard));
    opcodes.append(END);
  }

  enter(args: number) {
    let updating = new LinkedList<UpdatingOpcode>();

    let state = this.capture(args);
    let tracker = this.elements().pushUpdatableBlock();

    let tryOpcode = new TryOpcode(this.heap.gethandle(this.pc), state, tracker, updating);

    this.didEnter(tryOpcode);
  }

  iterate(memo: VersionedPathReference<Opaque>, value: VersionedPathReference<Opaque>): TryOpcode {
    let stack = this.stack;
    stack.push(value);
    stack.push(memo);

    let state = this.capture(2);
    let tracker = this.elements().pushUpdatableBlock();

    // let ip = this.ip;
    // this.ip = end + 4;
    // this.frames.push(ip);

    return new TryOpcode(this.heap.gethandle(this.pc), state, tracker, new LinkedList<UpdatingOpcode>());
  }

  enterItem(key: string, opcode: TryOpcode) {
    this.listBlock().map[key] = opcode;
    this.didEnter(opcode);
  }

  enterList(relativeStart: number) {
    let updating = new LinkedList<BlockOpcode>();

    let state = this.capture(0);
    let tracker = this.elements().pushBlockList(updating);
    let artifacts = this.stack.peek<ReferenceIterator>().artifacts;

    let start = this.heap.gethandle(typePos(this.pc + relativeStart));

    let opcode = new ListBlockOpcode(start, state, tracker, updating, artifacts);

    this.listBlockStack.push(opcode);

    this.didEnter(opcode);
  }

  private didEnter(opcode: BlockOpcode) {
    this.updateWith(opcode);
    this.updatingOpcodeStack.push(opcode.children);
  }

  exit() {
    this.elements().popBlock();
    this.updatingOpcodeStack.pop();

    let parent = this.updating().tail() as BlockOpcode;

    parent.didInitializeChildren();
  }

  exitList() {
    this.exit();
    this.listBlockStack.pop();
  }

  updateWith(opcode: UpdatingOpcode) {
    this.updating().append(opcode);
  }

  listBlock(): ListBlockOpcode {
    return expect(this.listBlockStack.current, 'expected a list block');
  }

  updating(): LinkedList<UpdatingOpcode> {
    return expect(this.updatingOpcodeStack.current, 'expected updating opcode on the updating opcode stack');
  }

  elements(): ElementBuilder {
    return this.elementStack;
  }

  scope(): Scope {
    return expect(this.scopeStack.current, 'expected scope on the scope stack');
  }

  dynamicScope(): DynamicScope {
    return expect(this.dynamicScopeStack.current, 'expected dynamic scope on the dynamic scope stack');
  }

  pushChildScope() {
    this.scopeStack.push(this.scope().child());
  }

  pushCallerScope(childScope = false) {
    let callerScope = expect(this.scope().getCallerScope(), 'pushCallerScope is called when a caller scope is present');
    this.scopeStack.push(childScope ? callerScope.child() : callerScope);
  }

  pushDynamicScope(): DynamicScope {
    let child = this.dynamicScope().child();
    this.dynamicScopeStack.push(child);
    return child;
  }

  pushRootScope(size: number, bindCaller: boolean): Scope {
    let scope = Scope.sized(size);
    if (bindCaller) scope.bindCallerScope(this.scope());
    this.scopeStack.push(scope);
    return scope;
  }

  popScope() {
    this.scopeStack.pop();
  }

  popDynamicScope() {
    this.dynamicScopeStack.pop();
  }

  newDestroyable(d: Destroyable) {
    this.elements().didAddDestroyable(d);
  }

  /// SCOPE HELPERS

  getSelf(): PathReference<any> {
    return this.scope().getSelf();
  }

  referenceForSymbol(symbol: number): PathReference<any> {
    return this.scope().getSymbol(symbol);
  }

  /// EXECUTION

  execute(start: Handle, initialize?: (vm: VM) => void): RenderResult {
    this.pc = this.heap.getaddr(start);

    if (initialize) initialize(this);

    let result: IteratorResult<RenderResult>;

    while (true) {
      result = this.next();
      if (result.done) break;
    }

    return result.value as RenderResult;
  }

  next(): IteratorResult<RenderResult> {
    let { env, updatingOpcodeStack, elementStack } = this;
    let opcode = this.nextStatement(env);
    let result: IteratorResult<RenderResult>;
    if (opcode !== null) {
      APPEND_OPCODES.evaluate(this, opcode, opcode.type);
      result = { done: false, value: null };
    } else {
      // Unload the stack
      this.stack.reset();

      result = {
        done: true,
        value: new RenderResult(
          env,
          expect(updatingOpcodeStack.pop(), 'there should be a final updating opcode stack'),
          elementStack.popBlock()
        )
      };
    }
    return result;
  }

  private nextStatement(env: Environment): Option<Opcode> {
    let { pc } = this;

    if (pc === -1) {
      return null;
    }

    let program = env.program;
    this.pc += 4;
    return program.opcode(pc);
  }

  evaluateOpcode(opcode: Opcode) {
    APPEND_OPCODES.evaluate(this, opcode, opcode.type);
  }

  bindDynamicScope(names: ConstantString[]) {
    let scope = this.dynamicScope();

    for(let i=names.length - 1; i>=0; i--) {
      let name = this.constants.getString(names[i]);
      scope.set(name, this.stack.pop<VersionedPathReference<Opaque>>());
    }
  }
}
