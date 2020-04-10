import * as es from 'estree'
import { ErrorSeverity, ErrorType, SourceError, Type, TypeAnnotatedNode } from '../types'
import { simplify, stripIndent } from '../utils/formatters'
import { typeToString } from '../utils/stringify'
import { generate } from 'astring'

// tslint:disable:max-classes-per-file

export class InvalidArgumentTypesError implements SourceError {
  public type = ErrorType.TYPE
  public severity = ErrorSeverity.WARNING

  constructor(
    public node: TypeAnnotatedNode<es.Node>,
    public args: TypeAnnotatedNode<es.Node>[],
    public expectedTypes: Type[],
    public receivedTypes: Type[]
  ) {}

  get location() {
    return this.node.loc!
  }

  public explain() {
    const argStrings = this.args.map(arg => simplify(generate(arg)))
    if ('operator' in this.node) {
      const op = this.node.operator
      if (this.expectedTypes.length === 2) {
        // binary operator
        return stripIndent`
        A type mismatch was detected in the binary expression:
          ${argStrings[0]} ${op} ${argStrings[1]}
        The binary operator (${op}) expected two operands with types:
          ${typeToString(this.expectedTypes[0])} ${op} ${typeToString(this.expectedTypes[1])}
        but instead it received two operands of types:
          ${typeToString(this.receivedTypes[0])} ${op} ${typeToString(this.receivedTypes[1])}
        `
      } else {
        // unary operator
        return stripIndent`
        A type mismatch was detected in the unary expression:
          ${op} ${argStrings[0]}
        The unary operator (${op}) expected its operand to be of type:
          ${typeToString(this.expectedTypes[0])}
        but instead it received an operand of type:
          ${typeToString(this.receivedTypes[0])}
        `
      }
    }
    const functionString = simplify(generate(this.node))
    function formatPhrasing(types: Type[]) {
      switch (types.length) {
        case 0:
          return 'no arguments,'
        case 1:
          return `an argument of type:
      ${typeToString(types[0])}`
        default:
          return `${types.length} arguments of types:
      ${types.map(typeToString).join(', ')}`
      }
    }
    return stripIndent`
    A type mismatch was detected in the function call:
      ${functionString}(${argStrings.join(', ')})
    The function expected ${formatPhrasing(this.expectedTypes)}
    but instead received ${formatPhrasing(this.receivedTypes)}
    `
  }

  public elaborate() {
    return this.explain()
  }
}

function formatIf(node: TypeAnnotatedNode<es.IfStatement | es.ConditionalExpression>) {
  let ifString = simplify(generate(node.test))
  let type
  if (node.type === 'IfStatement') {
    ifString = `if (${ifString}) { ... } else { ... }`
    type = 'if statement'
  } else {
    ifString = `${ifString} ? ... : ...`
    type = 'conditional expression'
  }
  return { ifString, type }
}

export class InvalidTestConditionError implements SourceError {
  public type = ErrorType.TYPE
  public severity = ErrorSeverity.WARNING

  constructor(
    public node: TypeAnnotatedNode<es.IfStatement | es.ConditionalExpression>,
    public receivedType: Type
  ) {}

  get location() {
    return this.node.loc!
  }

  public explain() {
    const { ifString, type } = formatIf(this.node)
    return stripIndent`
    Expected the test part of the ${type}:
      ${ifString}
    to have type boolean, but instead it is type:
      ${typeToString(this.receivedType)}
    `
  }

  public elaborate() {
    return this.explain()
  }
}

export class ConsequentAlternateMismatchError implements SourceError {
  public type = ErrorType.TYPE
  public severity = ErrorSeverity.WARNING

  constructor(
    public node: TypeAnnotatedNode<es.IfStatement | es.ConditionalExpression>,
    public consequentType: Type,
    public alternateType: Type
  ) {}

  get location() {
    return this.node.loc!
  }

  public explain() {
    const { ifString, type } = formatIf(this.node)
    return stripIndent`
    The two branches of the ${type}:
      ${ifString}
    produce different types!
    The true branch has type:
      ${typeToString(this.consequentType)}
    but the false branch has type:
      ${typeToString(this.alternateType)}
    `
  }

  public elaborate() {
    return this.explain()
  }
}

