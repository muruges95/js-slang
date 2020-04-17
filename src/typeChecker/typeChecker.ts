import * as es from 'estree'
import {
  TypeAnnotatedNode,
  Primitive,
  Variable,
  Pair,
  List,
  ForAll,
  SArray,
  Type,
  FunctionType,
  TypeAnnotatedFuncDecl,
  SourceError,
  AllowedDeclarations
} from '../types'
import {
  TypeError,
  InternalTypeError,
  UnifyError,
  InternalDifferentNumberArgumentsError,
  InternalCyclicReferenceError
} from './internalTypeErrors'
import {
  ConsequentAlternateMismatchError,
  InvalidTestConditionError,
  DifferentNumberArgumentsError,
  InvalidArgumentTypesError,
  CyclicReferenceError,
  DifferentAssignmentError,
  ReassignConstError,
  ArrayAssignmentError,
  InvalidArrayIndexType,
  UndefinedIdentifierError
} from '../errors/typeErrors'
import { typeToString } from '../utils/stringify'
/* tslint:disable:object-literal-key-quotes no-console no-string-literal*/

/** Name of Unary negative builtin operator */
const NEGATIVE_OP = '-_1'
let typeIdCounter = 0

/**
 * Called before and after type inference. First to add typeVar attribute to node, second to resolve
 * the type
 * FunctionDeclaration nodes have the functionTypeVar attribute as well
 * @param node
 * @param constraints: undefined for first call
 */
/* tslint:disable cyclomatic-complexity */
function traverse(node: TypeAnnotatedNode<es.Node>, constraints?: Constraint[]) {
  if (constraints && node.typability !== 'Untypable') {
    try {
      node.inferredType = applyConstraints(node.inferredType as Type, constraints)
      node.typability = 'Typed'
    } catch (e) {
      if (isInternalTypeError(e) && !(e instanceof InternalCyclicReferenceError)) {
        typeErrors.push(new TypeError(node, e))
      }
    }
  } else {
    node.inferredType = tVar(typeIdCounter)
    typeIdCounter++
  }
  switch (node.type) {
    case 'Program': {
      node.body.forEach(nodeBody => {
        traverse(nodeBody, constraints)
      })
      break
    }
    case 'UnaryExpression': {
      traverse(node.argument, constraints)
      break
    }
    case 'LogicalExpression': // both cases are the same
    case 'BinaryExpression': {
      traverse(node.left, constraints)
      traverse(node.right, constraints)
      break
    }
    case 'ExpressionStatement': {
      traverse(node.expression, constraints)
      break
    }
    case 'BlockStatement': {
      node.body.forEach(nodeBody => {
        traverse(nodeBody, constraints)
      })
      break
    }
    case 'WhileStatement': {
      traverse(node.test, constraints)
      traverse(node.body, constraints)
      break
    }
    case 'ForStatement': {
      traverse(node.init!, constraints)
      traverse(node.test!, constraints)
      traverse(node.update!, constraints)
      traverse(node.body, constraints)
      break
    }
    case 'ConditionalExpression': // both cases are the same
    case 'IfStatement': {
      traverse(node.test, constraints)
      traverse(node.consequent, constraints)
      if (node.alternate) {
        traverse(node.alternate, constraints)
      }
      break
    }
    case 'CallExpression': {
      traverse(node.callee, constraints)
      node.arguments.forEach(arg => {
        traverse(arg, constraints)
      })
      break
    }
    case 'ReturnStatement': {
      const arg = node.argument!
      traverse(arg, constraints)
      break
    }
    case 'VariableDeclaration': {
      const init = node.declarations[0].init!
      traverse(init, constraints)
      break
    }
    case 'ArrowFunctionExpression': {
      node.params.forEach(param => {
        traverse(param, constraints)
      })
      traverse(node.body, constraints)
      break
    }
    case 'FunctionDeclaration': {
      const funcDeclNode = node as TypeAnnotatedFuncDecl
      if (constraints) {
        try {
          funcDeclNode.functionInferredType = applyConstraints(
            funcDeclNode.functionInferredType as Type,
            constraints
          )
        } catch (e) {
          if (e instanceof InternalCyclicReferenceError) {
            typeErrors.push(new CyclicReferenceError(node))
          } else if (isInternalTypeError(e)) {
            typeErrors.push(new TypeError(node, e))
          }
        }
      } else {
        funcDeclNode.functionInferredType = tVar(typeIdCounter)
      }
      typeIdCounter++
      funcDeclNode.params.forEach(param => {
        traverse(param, constraints)
      })
      traverse(funcDeclNode.body, constraints)
      break
    }
    case 'AssignmentExpression':
      traverse(node.left, constraints)
      traverse(node.right, constraints)
      break
    case 'ArrayExpression':
      node.elements.forEach(element => traverse(element, constraints))
      break
    case 'MemberExpression':
      traverse(node.object, constraints)
      traverse(node.property, constraints)
      break
    case 'Literal':
    case 'Identifier':
    default:
      return
  }
}

function isPair(type: Type): type is Pair {
  return type.kind === 'pair'
}

function isList(type: Type): type is List {
  return type.kind === 'list'
}

function getListType(type: Type): Type | null {
  if (isList(type)) {
    return type.elementType
  }
  return null
}

function isInternalTypeError(error: any) {
  return error instanceof InternalTypeError
}

// Type Definitions
// Our type environment maps variable names to types.
// it also remembers if names weer declared as const or let
interface Env {
  typeMap: Map<string, Type | ForAll>
  declKindMap: Map<string, AllowedDeclarations>
}

function cloneEnv(env: Env): Env {
  return {
    typeMap: new Map(env.typeMap.entries()),
    declKindMap: new Map(env.declKindMap.entries())
  }
}

type Constraint = [Variable, Type]
let typeErrors: SourceError[] = []
/**
 * An additional layer of typechecking to be done right after parsing.
 * @param program Parsed Program
 */
export function typeCheck(
  program: TypeAnnotatedNode<es.Program>
): [TypeAnnotatedNode<es.Program>, SourceError[]] {
  typeIdCounter = 0
  typeErrors = []
  const env: Env = cloneEnv(initialEnv)
  const constraints: Constraint[] = []
  traverse(program)
  infer(program, env, constraints, true)
  traverse(program, constraints)
  return [program, typeErrors]
}

/**
 * Generate a fresh type variable
 * @param typeVar
 */
function freshTypeVar(typeVar: Variable): Variable {
  const newVarId = typeIdCounter
  typeIdCounter++
  return {
    ...typeVar,
    name: `T${newVarId}`
  }
}

/**
 * Replaces all instances of type variables in the type of a polymorphic type
 */
function fresh(monoType: Type, subst: { [typeName: string]: Variable }): Type {
  switch (monoType.kind) {
    case 'primitive':
      return monoType
    case 'list':
      return {
        kind: 'list',
        elementType: fresh(monoType.elementType, subst)
      }
    case 'array':
      return {
        kind: 'array',
        elementType: fresh(monoType.elementType, subst)
      }
    case 'pair':
      return {
        kind: 'pair',
        headType: fresh(monoType.headType, subst),
        tailType: fresh(monoType.tailType, subst)
      }
    case 'variable':
      return subst[monoType.name]
    case 'function':
      return {
        ...monoType,
        parameterTypes: monoType.parameterTypes.map(argType => fresh(argType, subst)),
        returnType: fresh(monoType.returnType, subst)
      }
  }
}

/** Union of free type variables */
function union(a: Variable[], b: Variable[]): Variable[] {
  const sum = [...a]
  b.forEach(newVal => {
    if (sum.findIndex(val => val.name === newVal.name) === -1) {
      sum.push(newVal)
    }
  })
  return sum
}

function freeTypeVarsInType(type: Type): Variable[] {
  switch (type.kind) {
    case 'primitive':
      return []
    case 'list':
      return freeTypeVarsInType(type.elementType)
    case 'array':
      return freeTypeVarsInType(type.elementType)
    case 'pair':
      return union(freeTypeVarsInType(type.headType), freeTypeVarsInType(type.tailType))
    case 'variable':
      return [type]
    case 'function':
      return union(
        type.parameterTypes.reduce((acc, currentType) => {
          return union(acc, freeTypeVarsInType(currentType))
        }, []),
        freeTypeVarsInType(type.returnType)
      )
  }
}

function extractFreeVariablesAndGenFresh(polyType: ForAll): Type {
  const monoType = polyType.polyType
  const freeTypeVars = freeTypeVarsInType(monoType)
  const substitutions = {}
  freeTypeVars.forEach(val => {
    substitutions[val.name] = freshTypeVar(val)
  })
  return fresh(monoType, substitutions)
}

/**
 * Going down the DAG that is the constraint list
 * Apply the following normalizations
 * List<T1> ==> Pair<T1, List<T1>>
 * Pair<T1, Pair<T2, List<T3>> -> Pair<T4, List<T4>>
 */
function applyConstraints(type: Type, constraints: Constraint[]): Type {
  const result = __applyConstraints(type, constraints)
  if (isList(result)) {
    const list = result
    return {
      kind: 'pair',
      headType: getListType(list) as Type,
      tailType: list
    }
  } else if (isPair(result)) {
    const pair = result
    const _tail = pair.tailType
    if (isPair(_tail)) {
      const tail = _tail
      if (getListType(tail.tailType) !== null) {
        addToConstraintList(constraints, [tail.headType, getListType(tail.tailType) as Type])
        addToConstraintList(constraints, [tail.headType, pair.headType])
        return __applyConstraints(tail, constraints)
      }
    }
  }
  return result
}

/**
 * Going down the DAG that is the constraint list
 */
function __applyConstraints(type: Type, constraints: Constraint[]): Type {
  switch (type.kind) {
    case 'primitive': {
      return type
    }
    case 'pair': {
      return {
        kind: 'pair',
        headType: __applyConstraints(type.headType, constraints),
        tailType: __applyConstraints(type.tailType, constraints)
      }
    }
    case 'list': {
      const elementType = __applyConstraints(type.elementType, constraints)
      return {
        kind: 'list',
        elementType
      }
    }
    case 'array': {
      const elementType = __applyConstraints(type.elementType, constraints)
      return {
        kind: 'array',
        elementType
      }
    }
    case 'variable': {
      for (const constraint of constraints) {
        const LHS = constraint[0]
        const RHS = constraint[1]
        if (LHS.name === type.name) {
          if (contains(RHS, LHS.name)) {
            if (isPair(RHS) && LHS === RHS.tailType) {
              return {
                kind: 'list',
                elementType: RHS.headType
              }
            } else if (LHS.kind === 'variable' && LHS === getListType(RHS)) {
              return {
                kind: 'list',
                elementType: LHS
              }
            }
            throw new InternalCyclicReferenceError(type.name)
          }
          return applyConstraints(constraint[1], constraints)
        }
      }
      return type
    }
    case 'function': {
      return {
        ...type,
        parameterTypes: type.parameterTypes.map(fromType =>
          applyConstraints(fromType, constraints)
        ),
        returnType: applyConstraints(type.returnType, constraints)
      }
    }
  }
}

/**
 * Check if a type contains a reference to a name, to check for an infinite type
 * e.g. A = B -> A
 * @param type
 * @param name
 */
function contains(type: Type, name: string): boolean {
  switch (type.kind) {
    case 'primitive':
      return false
    case 'pair':
      return contains(type.headType, name) || contains(type.tailType, name)
    case 'array':
    case 'list':
      return contains(type.elementType, name)
    case 'variable':
      return type.name === name
    case 'function':
      const containedInParamTypes = type.parameterTypes.some(currentType =>
        contains(currentType, name)
      )
      return containedInParamTypes || contains(type.returnType, name)
  }
}

function occursOnLeftInConstraintList(
  LHS: Variable,
  constraints: Constraint[],
  RHS: Type
): Constraint[] {
  for (const constraint of constraints) {
    if (constraint[0].name === LHS.name) {
      // when LHS occurs earlier in original constrain list
      return addToConstraintList(constraints, [RHS, constraint[1]])
    }
  }
  if (RHS.kind === 'variable') {
    if (LHS.constraint === 'addable' && RHS.constraint === 'none') {
      // We need to modify the type of the RHS so that it is at least as specific as the LHS
      // this is so we are going from least to most specific as we recursively try to determine
      // type of a type variable
      RHS.constraint = LHS.constraint
    }
  }
  if (LHS !== RHS) constraints.push([LHS, RHS])
  return constraints
}

function cannotBeResolvedIfAddable(LHS: Variable, RHS: Type): boolean {
  return (
    LHS.constraint === 'addable' &&
    RHS.kind !== 'variable' &&
    !(RHS.kind === 'primitive' && (RHS.name === 'string' || RHS.name === 'number'))
  )
}

function addToConstraintList(constraints: Constraint[], [LHS, RHS]: [Type, Type]): Constraint[] {
  if (LHS.kind === 'primitive' && RHS.kind === 'primitive' && LHS.name === RHS.name) {
    return constraints
  } else if (LHS.kind === 'array' && RHS.kind === 'array') {
    return addToConstraintList(constraints, [LHS.elementType, RHS.elementType])
  } else if (LHS.kind === 'list' && RHS.kind === 'list') {
    return addToConstraintList(constraints, [LHS.elementType, RHS.elementType])
  } else if (LHS.kind === 'pair' && RHS.kind === 'list') { 
    // swap so that we hit the below rule
    return addToConstraintList(constraints, [RHS, LHS])
  } else if (LHS.kind === 'list' && RHS.kind === 'pair') {
    // t is List(t_el) and t' is pair type, then try to add constraint t' = Pair(t_el, t)
    return addToConstraintList(constraints, [RHS, tPair(LHS.elementType, LHS)])
  } else if (LHS.kind === 'pair' && RHS.kind === 'pair') {
    let newConstraints = constraints
    newConstraints = addToConstraintList(constraints, [LHS.headType, RHS.headType])
    newConstraints = addToConstraintList(constraints, [LHS.tailType, RHS.tailType])
    return newConstraints
  } else if (LHS.kind === 'variable') {
    // case when we have a new constraint like T_1 = T_1
    if (RHS.kind === 'variable' && RHS.name === LHS.name) {
      return constraints
    } else if (contains(RHS, LHS.name)) {
      if (isPair(RHS) && (LHS === RHS.tailType || LHS === getListType(RHS.tailType))) {
        // T1 = Pair<T2, T1> ===> T1 = List<T2>
        return addToConstraintList(constraints, [LHS, tList(RHS.headType)])
      } else if (LHS.kind === 'variable' && LHS === getListType(RHS)) {
        constraints.push([LHS, RHS])
        return constraints
      }
      throw new InternalCyclicReferenceError(LHS.name)
    }
    if (cannotBeResolvedIfAddable(LHS, RHS)) {
      throw new UnifyError(LHS, RHS)
    }
    // call to apply constraints ensures that there is no term in RHS that occurs earlier in constraint list on LHS
    return occursOnLeftInConstraintList(LHS, constraints, applyConstraints(RHS, constraints))
  } else if (RHS.kind === 'variable') {
    // swap around so the type var is on the left hand side
    return addToConstraintList(constraints, [RHS, LHS])
  } else if (LHS.kind === 'function' && RHS.kind === 'function') {
    if (LHS.parameterTypes.length !== RHS.parameterTypes.length) {
      throw new InternalDifferentNumberArgumentsError(
        RHS.parameterTypes.length,
        LHS.parameterTypes.length
      )
    }
    let newConstraints = constraints
    for (let i = 0; i < LHS.parameterTypes.length; i++) {
      newConstraints = addToConstraintList(newConstraints, [
        LHS.parameterTypes[i],
        RHS.parameterTypes[i]
      ])
    }
    newConstraints = addToConstraintList(newConstraints, [LHS.returnType, RHS.returnType])
    return newConstraints
  } else {
    throw new UnifyError(LHS, RHS)
  }
}

function statementHasReturn(node: es.Node): boolean {
  switch (node.type) {
    case 'IfStatement': {
      return statementHasReturn(node.consequent) || statementHasReturn(node.alternate!)
    }
    case 'BlockStatement': {
      return node.body.some(stmt => statementHasReturn(stmt))
    }
    case 'ForStatement':
    case 'WhileStatement': {
      return statementHasReturn(node.body)
    }
    case 'ReturnStatement': {
      return true
    }
    default: {
      return false
    }
  }
}

// These are the only two possible kinds of value returning statements when excluding return statements
function stmtHasValueReturningStmt(node: es.Node): boolean {
  switch (node.type) {
    case 'ExpressionStatement': {
      return true
    }
    case 'IfStatement': {
      return (
        stmtHasValueReturningStmt(node.consequent) || stmtHasValueReturningStmt(node.alternate!)
      )
    }
    case 'BlockStatement': {
      return node.body.some(stmt => stmtHasValueReturningStmt(stmt))
    }
    case 'ForStatement':
    case 'WhileStatement': {
      return stmtHasValueReturningStmt(node.body)
    }
    default: {
      return false
    }
  }
}

/**
 * The following is the index of the node whose value will be the value of the block itself.
 * At the top level and if we are currently in the last value returning stmt of the parent block stmt,
 * we will use the last value returning statement of the current block. Anywhere else, we will use
 * either the first return statement or the last statement in the block otherwise
 */
function returnBlockValueNodeIndexFor(
  node: es.Program | es.BlockStatement,
  isTopLevelAndLastValStmt: boolean
): number {
  const lastStatementIndex = node.body.length - 1
  if (isTopLevelAndLastValStmt) {
    let index = lastStatementIndex
    for (index = lastStatementIndex; index >= 0; index--) {
      if (stmtHasValueReturningStmt(node.body[index])) {
        return index
      }
    }
    // in the case there are no value returning statements in the body
    // return the last statement
    return lastStatementIndex
  } else {
    return node.body.findIndex((currentNode, index) => {
      return index === lastStatementIndex || statementHasReturn(currentNode)
    })
  }
}

/* tslint:disable cyclomatic-complexity */
function infer(
  node: TypeAnnotatedNode<es.Node>,
  env: Env,
  constraints: Constraint[],
  isTopLevelAndLastValStmt: boolean = false
): Constraint[] {
  try {
    return _infer(node, env, constraints, isTopLevelAndLastValStmt)
  } catch (e) {
    if (e instanceof InternalCyclicReferenceError) {
      // cyclic reference errors only happen in function declarations
      // which would have been caught when inferring it
      return constraints
    }
    throw e
  }
}

/* tslint:disable cyclomatic-complexity */
function _infer(
  node: TypeAnnotatedNode<es.Node>,
  env: Env,
  constraints: Constraint[],
  isTopLevelAndLastValStmt: boolean = false
): Constraint[] {
  const storedType = node.inferredType as Variable
  switch (node.type) {
    case 'UnaryExpression': {
      const op = node.operator === '-' ? NEGATIVE_OP : node.operator
      const funcType = env.typeMap.get(op) as FunctionType // in either case its a monomorphic type
      const argNode = node.argument as TypeAnnotatedNode<es.Node>
      const argType = argNode.inferredType as Variable
      const receivedTypes: Type[] = []
      let newConstraints = infer(argNode, env, constraints)
      receivedTypes.push(applyConstraints(argNode.inferredType!, newConstraints))
      try {
        newConstraints = addToConstraintList(newConstraints, [tFunc(argType, storedType), funcType])
      } catch (e) {
        if (e instanceof UnifyError) {
          const expectedTypes = funcType.parameterTypes
          typeErrors.push(
            new InvalidArgumentTypesError(node, [argNode], expectedTypes, receivedTypes)
          )
          return newConstraints
        }
      }
      return newConstraints
    }
    case 'LogicalExpression': // both cases are the same
    case 'BinaryExpression': {
      const envType = env.typeMap.get(node.operator)!
      const opType = envType.kind === 'forall' ? extractFreeVariablesAndGenFresh(envType) : envType
      const leftNode = node.left as TypeAnnotatedNode<es.Node>
      const leftType = leftNode.inferredType as Variable
      const rightNode = node.right as TypeAnnotatedNode<es.Node>
      const rightType = rightNode.inferredType as Variable

      const argNodes = [leftNode, rightNode]
      let newConstraints = constraints
      const receivedTypes: Type[] = []
      argNodes.forEach(argNode => {
        newConstraints = infer(argNode, env, newConstraints)
        receivedTypes.push(applyConstraints(argNode.inferredType!, newConstraints))
      })
      try {
        newConstraints = addToConstraintList(constraints, [
          tFunc(leftType, rightType, storedType),
          opType
        ])
      } catch (e) {
        if (e instanceof UnifyError) {
          const expectedTypes = (opType as FunctionType).parameterTypes
          typeErrors.push(
            new InvalidArgumentTypesError(node, argNodes, expectedTypes, receivedTypes)
          )
        }
      }
      return newConstraints
    }
    case 'ExpressionStatement': {
      return infer(node.expression, env, addToConstraintList(constraints, [storedType, tUndef]))
    }
    case 'ReturnStatement': {
      const argNode = node.argument as TypeAnnotatedNode<es.Node>
      return infer(
        argNode,
        env,
        addToConstraintList(constraints, [storedType, argNode.inferredType as Variable])
      )
    }
    case 'WhileStatement': {
      const testNode = node.test as TypeAnnotatedNode<es.Node>
      const testType = testNode.inferredType as Variable
      const bodyNode = node.body as TypeAnnotatedNode<es.Node>
      const bodyType = bodyNode.inferredType as Variable
      let newConstraints = addToConstraintList(constraints, [testType, tBool])
      newConstraints = addToConstraintList(newConstraints, [storedType, bodyType])
      try {
        newConstraints = infer(testNode, env, newConstraints)
      } catch (e) {
        if (e instanceof UnifyError) {
          typeErrors.push(new InvalidTestConditionError(node, e.LHS))
        }
      }
      return infer(bodyNode, env, newConstraints, isTopLevelAndLastValStmt)
    }
    case 'ForStatement': {
      let newEnv = env
      const initNode = node.init as TypeAnnotatedNode<es.Node>
      const testNode = node.test as TypeAnnotatedNode<es.Node>
      const testType = testNode.inferredType as Variable
      const bodyNode = node.body as TypeAnnotatedNode<es.Node>
      const bodyType = bodyNode.inferredType as Variable
      const updateNode = node.update as TypeAnnotatedNode<es.Node>
      let newConstraints = addToConstraintList(constraints, [storedType, bodyType])
      if (
        initNode.type === 'VariableDeclaration' &&
        initNode.kind !== 'var' &&
        initNode.declarations[0].id.type === 'Identifier'
      ) {
        // we need to introduce it into the scope and do something similar to what we do when
        // evaluating a block statement
        newEnv = cloneEnv(env)
        const initName = initNode.declarations[0].id.name
        newEnv.typeMap.set(
          initName,
          (initNode.declarations[0].init as TypeAnnotatedNode<es.Node>).inferredType as Variable
        )
        newEnv.declKindMap.set(initName, initNode.kind)
        newConstraints = infer(initNode, newEnv, newConstraints)
        newEnv.typeMap.set(
          initName,
          tForAll(
            applyConstraints(
              (initNode.declarations[0].init as TypeAnnotatedNode<es.Node>)
                .inferredType as Variable,
              newConstraints
            )
          )
        )
      } else {
        newConstraints = infer(initNode, newEnv, newConstraints)
      }
      try {
        newConstraints = infer(testNode, newEnv, newConstraints)
        newConstraints = addToConstraintList(newConstraints, [testType, tBool])
      } catch (e) {
        if (e instanceof UnifyError) {
          typeErrors.push(new InvalidTestConditionError(node, e.LHS))
        }
      }
      newConstraints = infer(updateNode, newEnv, newConstraints)
      return infer(bodyNode, newEnv, newConstraints, isTopLevelAndLastValStmt)
    }
    case 'Program':
    case 'BlockStatement': {
      const newEnv = cloneEnv(env) // create new scope
      const lastStatementIndex = node.body.length - 1
      const returnValNodeIndex = returnBlockValueNodeIndexFor(node, isTopLevelAndLastValStmt)
      let lastDeclNodeIndex = -1
      let lastDeclFound = false
      let n = lastStatementIndex
      const declNodes: (TypeAnnotatedFuncDecl | TypeAnnotatedNode<es.VariableDeclaration>)[] = []
      while (n >= 0) {
        const currNode = node.body[n]
        if (currNode.type === 'FunctionDeclaration' || currNode.type === 'VariableDeclaration') {
          // in the event we havent yet found our last decl
          if (!lastDeclFound) {
            lastDeclFound = true
            lastDeclNodeIndex = n
          }
          declNodes.push(currNode)
        }
        n--
      }
      declNodes.forEach(declNode => {
        if (declNode.type === 'FunctionDeclaration' && declNode.id !== null) {
          const declName = declNode.id.name
          newEnv.typeMap.set(declName, declNode.functionInferredType!)
          newEnv.declKindMap.set(declName, 'const')
        } else if (
          declNode.type === 'VariableDeclaration' &&
          declNode.kind !== 'var' &&
          declNode.declarations[0].id.type === 'Identifier'
        ) {
          const declName = declNode.declarations[0].id.name
          newEnv.typeMap.set(
            declName,
            (declNode.declarations[0].init as TypeAnnotatedNode<es.Node>).inferredType as Variable
          )
          newEnv.declKindMap.set(declName, declNode.kind)
        }
      })
      const lastNode = node.body[returnValNodeIndex] as TypeAnnotatedNode<es.Node>
      const lastNodeType = (isTopLevelAndLastValStmt && lastNode.type === 'ExpressionStatement'
        ? (lastNode.expression as TypeAnnotatedNode<es.Node>).inferredType
        : lastNode.inferredType) as Variable
      let newConstraints = addToConstraintList(constraints, [storedType, lastNodeType])
      for (let i = 0; i <= lastDeclNodeIndex; i++) {
        if (i === returnValNodeIndex) {
          newConstraints = infer(node.body[i], newEnv, newConstraints, isTopLevelAndLastValStmt)
        } else {
          newConstraints = infer(node.body[i], newEnv, newConstraints)
        }
      }
      declNodes.forEach(declNode => {
        if (declNode.type === 'FunctionDeclaration' && declNode.id !== null) {
          newEnv.typeMap.set(
            declNode.id.name,
            tForAll(applyConstraints(declNode.functionInferredType as Variable, newConstraints))
          )
        } else if (
          declNode.type === 'VariableDeclaration' &&
          declNode.declarations[0].id.type === 'Identifier'
        ) {
          newEnv.typeMap.set(
            declNode.declarations[0].id.name,
            tForAll(
              applyConstraints(
                (declNode.declarations[0].init as TypeAnnotatedNode<es.Node>)
                  .inferredType as Variable,
                newConstraints
              )
            )
          )
        }
      })
      for (let i = lastDeclNodeIndex + 1; i <= lastStatementIndex; i++) {
        // for the last statement, if it is an if statement, pass down isLastStatementinBlock variable
        const checkedNode = node.body[i]
        if (i === returnValNodeIndex) {
          newConstraints = infer(checkedNode, newEnv, newConstraints, isTopLevelAndLastValStmt)
        } else {
          newConstraints = infer(checkedNode, newEnv, newConstraints)
        }
      }
      return newConstraints
    }
    case 'Literal': {
      const literalVal = node.value
      const typeOfLiteral = typeof literalVal
      if (literalVal === null) {
        return addToConstraintList(constraints, [storedType, tList(tVar(typeIdCounter++))])
      } else if (typeOfLiteral === 'number') {
        return addToConstraintList(constraints, [storedType, tNumber])
      } else if (typeOfLiteral === 'boolean') {
        return addToConstraintList(constraints, [storedType, tBool])
      } else if (typeOfLiteral === 'string') {
        return addToConstraintList(constraints, [storedType, tString])
      }
      throw Error('Unexpected literal type')
    }
    case 'Identifier': {
      const identifierName = node.name
      if (env.typeMap.has(identifierName)) {
        const envType = env.typeMap.get(identifierName)!
        if (envType.kind === 'forall') {
          return addToConstraintList(constraints, [
            storedType,
            extractFreeVariablesAndGenFresh(envType)
          ])
        } else {
          return addToConstraintList(constraints, [storedType, envType])
        }
      }
      typeErrors.push(new UndefinedIdentifierError(node, identifierName))
      return constraints
    }
    case 'ConditionalExpression': // both cases are the same
    case 'IfStatement': {
      const testNode = node.test as TypeAnnotatedNode<es.Node>
      const testType = testNode.inferredType as Variable
      const consNode = node.consequent as TypeAnnotatedNode<es.Node>
      const consType = consNode.inferredType as Variable
      const altNode = node.alternate as TypeAnnotatedNode<es.Node>
      const altType = altNode.inferredType as Variable
      let newConstraints = addToConstraintList(constraints, [testType, tBool])
      newConstraints = addToConstraintList(newConstraints, [storedType, consType])
      try {
        newConstraints = infer(testNode, env, newConstraints)
      } catch (e) {
        if (e instanceof UnifyError) {
          typeErrors.push(new InvalidTestConditionError(node, e.LHS))
        }
      }
      newConstraints = infer(consNode, env, newConstraints, isTopLevelAndLastValStmt)
      try {
        newConstraints = infer(altNode, env, newConstraints, isTopLevelAndLastValStmt)
        newConstraints = addToConstraintList(newConstraints, [consType, altType])
      } catch (e) {
        if (e instanceof UnifyError) {
          typeErrors.push(new ConsequentAlternateMismatchError(node, e.RHS, e.LHS))
        }
      }
      return newConstraints
    }
    case 'ArrowFunctionExpression': {
      const newEnv = cloneEnv(env) // create new scope
      const paramNodes = node.params
      const paramTypes: Variable[] = paramNodes.map(
        paramNode => (paramNode as TypeAnnotatedNode<es.Node>).inferredType as Variable
      )
      const bodyNode = node.body as TypeAnnotatedNode<es.Node>
      paramTypes.push(bodyNode.inferredType as Variable)
      const newConstraints = addToConstraintList(constraints, [storedType, tFunc(...paramTypes)])
      paramNodes.forEach((paramNode: TypeAnnotatedNode<es.Identifier>) => {
        newEnv.typeMap.set(paramNode.name, paramNode.inferredType as Variable)
      })
      return infer(bodyNode, newEnv, newConstraints)
    }
    case 'VariableDeclaration': {
      const initNode = node.declarations[0].init!
      return infer(initNode, env, addToConstraintList(constraints, [storedType, tUndef]))
    }
    case 'FunctionDeclaration': {
      const funcDeclNode = node as TypeAnnotatedFuncDecl
      let newConstraints = addToConstraintList(constraints, [storedType, tUndef])
      const newEnv = cloneEnv(env) // create new scope
      const storedFunctionType = funcDeclNode.functionInferredType as Variable
      const paramNodes = node.params as TypeAnnotatedNode<es.Pattern>[]
      const paramTypes = paramNodes.map(paramNode => paramNode.inferredType as Variable)
      const bodyNode = node.body as TypeAnnotatedNode<es.BlockStatement>
      paramTypes.push(bodyNode.inferredType as Variable)
      newConstraints = addToConstraintList(newConstraints, [
        storedFunctionType,
        tFunc(...paramTypes)
      ])
      paramNodes.forEach((paramNode: TypeAnnotatedNode<es.Identifier>) => {
        newEnv.typeMap.set(paramNode.name, paramNode.inferredType as Variable)
      })
      return infer(bodyNode, newEnv, newConstraints)
    }
    case 'CallExpression': {
      const calleeNode = node.callee as TypeAnnotatedNode<es.Node>
      const calleeType = calleeNode.inferredType as Variable
      const argNodes = node.arguments as TypeAnnotatedNode<es.Node>[]
      const argTypes: Variable[] = argNodes.map(argNode => argNode.inferredType as Variable)
      argTypes.push(storedType)
      let newConstraints = constraints
      newConstraints = infer(calleeNode, env, newConstraints)
      const calledFunctionType = applyConstraints(
        (calleeNode as TypeAnnotatedNode<es.Node>).inferredType!,
        newConstraints
      )
      const receivedTypes: Type[] = []
      argNodes.forEach(argNode => {
        newConstraints = infer(argNode, env, newConstraints)
        receivedTypes.push(applyConstraints(argNode.inferredType!, newConstraints))
      })
      try {
        newConstraints = addToConstraintList(constraints, [tFunc(...argTypes), calleeType])
      } catch (e) {
        if (e instanceof UnifyError) {
          const expectedTypes = (calledFunctionType as FunctionType).parameterTypes
          typeErrors.push(
            new InvalidArgumentTypesError(node, argNodes, expectedTypes, receivedTypes)
          )
        } else if (e instanceof InternalDifferentNumberArgumentsError) {
          typeErrors.push(new DifferentNumberArgumentsError(node, e.numExpectedArgs, e.numReceived))
        }
      }
      return newConstraints
    }
    case 'AssignmentExpression': {
      // need to handle array item assignment
      // Two cases:
      // 1. LHS is identifier
      // 2. LHS is member expression
      // x = ...., need to check that x is not const
      // arr[x]
      const leftNode = node.left as TypeAnnotatedNode<es.Identifier | es.MemberExpression>
      const rightNode = node.right as TypeAnnotatedNode<es.Node>
      const rightType = rightNode.inferredType as Variable
      let newConstraints = infer(rightNode, env, constraints)
      newConstraints = addToConstraintList(newConstraints, [storedType, rightType])
      if (leftNode.type === 'Identifier') {
        if (env.declKindMap.get(leftNode.name) === 'const') {
          typeErrors.push(new ReassignConstError(node))
          return newConstraints
        }
        const leftNodeType = env.typeMap.get(leftNode.name)!
        const expectedType =
          leftNodeType.kind === 'forall'
            ? extractFreeVariablesAndGenFresh(leftNodeType)
            : leftNodeType
        try {
          return addToConstraintList(newConstraints, [rightType, expectedType])
        } catch (e) {
          if (e instanceof UnifyError) {
            typeErrors.push(
              new DifferentAssignmentError(
                node,
                expectedType,
                applyConstraints(rightType, newConstraints)
              )
            )
            return newConstraints
          }
        }
      } else {
        newConstraints = infer(leftNode, env, newConstraints) // catch invalid index type
        // assert that RHS = array element type
        try {
          return addToConstraintList(newConstraints, [rightType, leftNode.inferredType!])
        } catch (e) {
          if (e instanceof UnifyError) {
            typeErrors.push(
              new ArrayAssignmentError(
                node,
                tArray(applyConstraints(leftNode.inferredType!, newConstraints)),
                applyConstraints(rightType, newConstraints)
              )
            )
          }
        }
      }
      return newConstraints
    }
    case 'ArrayExpression': {
      let newConstraints = constraints
      const elements = node.elements as TypeAnnotatedNode<es.Node>[]
      // infer the types of array elements
      elements.forEach(element => {
        newConstraints = infer(element, env, newConstraints)
      })
      const arrayElementType = tVar(typeIdCounter++)
      newConstraints = addToConstraintList(newConstraints, [storedType, tArray(arrayElementType)])
      elements.forEach(element => {
        try {
          newConstraints = addToConstraintList(newConstraints, [
            arrayElementType,
            element.inferredType!
          ])
        } catch (e) {
          if (e instanceof UnifyError) {
            typeErrors.push(
              new ArrayAssignmentError(
                node,
                applyConstraints(node.inferredType!, newConstraints) as SArray,
                applyConstraints(element.inferredType!, newConstraints)
              )
            )
          }
        }
      })
      return newConstraints
    }
    case 'MemberExpression': {
      // object and property
      // need to check that property is number and add constraints that inferredType is array
      // element type
      const obj = node.object as TypeAnnotatedNode<es.Identifier>
      const objName = obj.name
      const property = node.property as TypeAnnotatedNode<es.Node>
      const propertyType = property.inferredType as Variable
      let newConstraints = infer(property, env, constraints)
      // Check that property is of type number
      // type in env can be either var or forall
      const envType = env.typeMap.get(objName)!
      const arrayType =
        envType.kind === 'forall'
          ? extractFreeVariablesAndGenFresh(envType)
          : applyConstraints(envType, newConstraints)
      if (arrayType.kind !== 'array')
        throw new InternalTypeError(
          `Expected ${objName} to be an array, got ${typeToString(arrayType)}`
        )
      const expectedElementType = arrayType.elementType
      try {
        newConstraints = addToConstraintList(constraints, [propertyType, tNumber])
      } catch (e) {
        if (e instanceof UnifyError) {
          typeErrors.push(
            new InvalidArrayIndexType(node, applyConstraints(propertyType, newConstraints))
          )
        }
      }
      return addToConstraintList(newConstraints, [storedType, expectedElementType])
    }
    default:
      return constraints
  }
}

// =======================================
// Private Helper Parsing Functions
// =======================================

function tPrimitive(name: Primitive['name']): Primitive {
  return {
    kind: 'primitive',
    name
  }
}

function tVar(name: string | number): Variable {
  return {
    kind: 'variable',
    name: `T${name}`,
    constraint: 'none'
  }
}

function tAddable(name: string): Variable {
  return {
    kind: 'variable',
    name: `${name}`,
    constraint: 'addable'
  }
}

function tPair(var1: Type, var2: Type): Pair {
  return {
    kind: 'pair',
    headType: var1,
    tailType: var2
  }
}

function tList(var1: Type): List {
  return {
    kind: 'list',
    elementType: var1
  }
}

function tForAll(type: Type): ForAll {
  return {
    kind: 'forall',
    polyType: type
  }
}

function tArray(var1: Type): SArray {
  return {
    kind: 'array',
    elementType: var1
  }
}

const tBool = tPrimitive('boolean')
const tNumber = tPrimitive('number')
const tString = tPrimitive('string')
const tUndef = tPrimitive('undefined')

function tFunc(...types: Type[]): FunctionType {
  const parameterTypes = types.slice(0, -1)
  const returnType = types.slice(-1)[0]
  return {
    kind: 'function',
    parameterTypes,
    returnType
  }
}

const predeclaredNames: [string, Type | ForAll][] = [
  // constants
  ['Infinity', tNumber],
  ['NaN', tNumber],
  ['undefined', tUndef],
  ['math_LN2', tNumber],
  ['math_LN10', tNumber],
  ['math_LOG2E', tNumber],
  ['math_LOG10E', tNumber],
  ['math_PI', tNumber],
  ['math_SQRT1_2', tNumber],
  ['math_SQRT2', tNumber],
  // is something functions
  ['is_boolean', tForAll(tFunc(tVar('T'), tBool))],
  ['is_number', tForAll(tFunc(tVar('T'), tBool))],
  ['is_string', tForAll(tFunc(tVar('T'), tBool))],
  ['is_undefined', tForAll(tFunc(tVar('T'), tBool))],
  // math functions
  ['math_abs', tFunc(tNumber, tNumber)],
  ['math_acos', tFunc(tNumber, tNumber)],
  ['math_acosh', tFunc(tNumber, tNumber)],
  ['math_asin', tFunc(tNumber, tNumber)],
  ['math_asinh', tFunc(tNumber, tNumber)],
  ['math_atan', tFunc(tNumber, tNumber)],
  ['math_atan2', tFunc(tNumber, tNumber, tNumber)],
  ['math_atanh', tFunc(tNumber, tNumber)],
  ['math_cbrt', tFunc(tNumber, tNumber)],
  ['math_ceil', tFunc(tNumber, tNumber)],
  ['math_clz32', tFunc(tNumber, tNumber)],
  ['math_cos', tFunc(tNumber, tNumber)],
  ['math_cosh', tFunc(tNumber, tNumber)],
  ['math_exp', tFunc(tNumber, tNumber)],
  ['math_expm1', tFunc(tNumber, tNumber)],
  ['math_floor', tFunc(tNumber, tNumber)],
  ['math_fround', tFunc(tNumber, tNumber)],
  ['math_hypot', tForAll(tVar('T'))],
  ['math_imul', tFunc(tNumber, tNumber, tNumber)],
  ['math_log', tFunc(tNumber, tNumber)],
  ['math_log1p', tFunc(tNumber, tNumber)],
  ['math_log2', tFunc(tNumber, tNumber)],
  ['math_log10', tFunc(tNumber, tNumber)],
  ['math_max', tForAll(tVar('T'))],
  ['math_min', tForAll(tVar('T'))],
  ['math_pow', tFunc(tNumber, tNumber, tNumber)],
  ['math_random', tFunc(tNumber)],
  ['math_round', tFunc(tNumber, tNumber)],
  ['math_sign', tFunc(tNumber, tNumber)],
  ['math_sin', tFunc(tNumber, tNumber)],
  ['math_sinh', tFunc(tNumber, tNumber)],
  ['math_sqrt', tFunc(tNumber, tNumber)],
  ['math_tan', tFunc(tNumber, tNumber)],
  ['math_tanh', tFunc(tNumber, tNumber)],
  ['math_trunc', tFunc(tNumber, tNumber)],
  // misc functions
  ['parse_int', tFunc(tString, tNumber, tNumber)],
  ['prompt', tFunc(tString, tString)],
  ['runtime', tFunc(tNumber)],
  ['stringify', tForAll(tFunc(tVar('T'), tString))],
  ['display', tForAll(tVar('T'))],
  ['error', tForAll(tVar('T'))]
]

const headType = tVar('headType')
const tailType = tVar('tailType')

const pairFuncs: [string, Type | ForAll][] = [
  ['pair', tForAll(tFunc(headType, tailType, tPair(headType, tailType)))],
  ['head', tForAll(tFunc(tPair(headType, tailType), headType))],
  ['tail', tForAll(tFunc(tPair(headType, tailType), tailType))],
  ['is_pair', tForAll(tFunc(tVar('T'), tBool))],
  ['is_null', tForAll(tFunc(tPair(headType, tailType), tBool))],
  // Only for Source 3 and above (TODO make it hidden if less then Source 3)
  ['set_head', tForAll(tFunc(tPair(headType, tailType), headType, tUndef))],
  ['set_tail', tForAll(tFunc(tPair(headType, tailType), tailType, tUndef))],
]

const arrayFuncs: [string, Type | ForAll][] = [
  ['is_array', tForAll(tFunc(tVar('T'), tBool))],
  ['array_length', tForAll(tFunc(tArray(tVar('T')), tNumber))]
]

const listFuncs: [string, Type | ForAll][] = [['list', tForAll(tVar('T1'))]]

const primitiveFuncs: [string, Type | ForAll][] = [
  [NEGATIVE_OP, tFunc(tNumber, tNumber)],
  ['!', tFunc(tBool, tBool)],
  ['&&', tForAll(tFunc(tBool, tVar('T'), tVar('T')))],
  ['||', tForAll(tFunc(tBool, tVar('T'), tVar('T')))],
  // NOTE for now just handle for Number === Number
  ['===', tForAll(tFunc(tAddable('A'), tAddable('A'), tBool))],
  ['!==', tForAll(tFunc(tAddable('A'), tAddable('A'), tBool))],
  ['<', tForAll(tFunc(tAddable('A'), tAddable('A'), tBool))],
  ['<=', tForAll(tFunc(tAddable('A'), tAddable('A'), tBool))],
  ['>', tForAll(tFunc(tAddable('A'), tAddable('A'), tBool))],
  ['>=', tForAll(tFunc(tAddable('A'), tAddable('A'), tBool))],
  ['+', tForAll(tFunc(tAddable('A'), tAddable('A'), tAddable('A')))],
  ['%', tFunc(tNumber, tNumber, tNumber)],
  ['-', tFunc(tNumber, tNumber, tNumber)],
  ['*', tFunc(tNumber, tNumber, tNumber)],
  ['/', tFunc(tNumber, tNumber, tNumber)]
]

const initialTypeMappings = [
  ...predeclaredNames,
  ...pairFuncs,
  ...listFuncs,
  ...arrayFuncs,
  ...primitiveFuncs
]

const initialEnv: Env = {
  typeMap: new Map(initialTypeMappings),
  declKindMap: new Map(initialTypeMappings.map(val => [val[0], 'const']))
}
