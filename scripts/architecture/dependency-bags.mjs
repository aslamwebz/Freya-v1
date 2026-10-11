import ts from 'typescript'
import { hash } from './source.mjs'

const bagName = /(?:context|ctx|dependencies|dependencybag|deps|services|servicebag)$/i
const serviceName = /(?:Service|Engine|Host|Runtime|Gateway|Store|Provider|Client|Controller|Manager|Repository)$/

export function dependencyBags(file) {
  const findings = []
  const aliases = new Map()
  function collect(node) {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node.type)
    if (ts.isInterfaceDeclaration(node)) aliases.set(node.name.text, node)
    ts.forEachChild(node, collect)
  }
  collect(file.ast)
  function unalias(type, seen = new Set()) {
    if (type && ts.isTypeReferenceNode(type) && aliases.has(type.typeName.getText(file.ast)) && !seen.has(type.typeName.getText(file.ast))) {
      seen.add(type.typeName.getText(file.ast))
      return unalias(aliases.get(type.typeName.getText(file.ast)), seen)
    }
    return type
  }
  function wholeCore(type) {
    type = unalias(type)
    return !!type && ((ts.isTypeReferenceNode(type) && /(?:^|\.)FreyaCore$/.test(type.typeName.getText(file.ast)))
      || (ts.isTypeReferenceNode(type) && /^(?:Partial|Required|Readonly|Pick|Omit)$/.test(type.typeName.getText(file.ast)) && wholeCore(type.typeArguments?.[0]))
      || ((ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) && type.types.some(wholeCore)))
  }
  function broad(type) {
    type = unalias(type)
    if (!type) return false
    if (type.kind === ts.SyntaxKind.AnyKeyword) return true
    if (ts.isTypeReferenceNode(type) && /^(?:Partial|Required|Readonly)$/.test(type.typeName.getText(file.ast))) return broad(type.typeArguments?.[0])
    if (ts.isTypeReferenceNode(type) && type.typeName.getText(file.ast) === 'Record') return type.typeArguments?.[0]?.kind === ts.SyntaxKind.StringKeyword && [ts.SyntaxKind.AnyKeyword, ts.SyntaxKind.UnknownKeyword].includes(type.typeArguments?.[1]?.kind)
    return (ts.isTypeLiteralNode(type) || ts.isInterfaceDeclaration(type)) && type.members.some(member => ts.isIndexSignatureDeclaration(member) && [ts.SyntaxKind.AnyKeyword, ts.SyntaxKind.UnknownKeyword].includes(member.type?.kind))
  }
  function add(node, label) {
    // Declaration fingerprint prevents adding services to an excepted bag.
    const signature = node.getText(file.ast).replace(/\s+/g, ' ').trim()
    findings.push({ key: `${file.name}: ${label} #${hash(signature)}`, file: file.name, line: file.ast.getLineAndCharacterOfPosition(node.getStart(file.ast)).line + 1, label })
  }
  function visit(node) {
    if (ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isVariableDeclaration(node)) {
      const name = node.name?.getText(file.ast) ?? ''
      if (wholeCore(node.type)) add(node, `whole FreyaCore dependency ${name}`)
      else if (bagName.test(name) && broad(node.type)) add(node, `generic dependency container ${name}`)
    }
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && bagName.test(node.name.text)) {
      const members = ts.isInterfaceDeclaration(node) ? node.members : ts.isTypeLiteralNode(node.type) ? node.type.members : []
      const indexBag = members.some(member => ts.isIndexSignatureDeclaration(member) && [ts.SyntaxKind.AnyKeyword, ts.SyntaxKind.UnknownKeyword].includes(member.type?.kind))
      const serviceMembers = members.filter(member => member.type && ts.isTypeReferenceNode(member.type) && serviceName.test(member.type.typeName.getText(file.ast)))
      const callbacks = members.filter(member => ts.isMethodSignature(member) || (member.type && ts.isFunctionTypeNode(member.type)))
      const explicitServices = /(?:services|servicebag)$/i.test(node.name.text) && callbacks.length >= 3
      if (indexBag || serviceMembers.length >= 3 || explicitServices || (ts.isTypeAliasDeclaration(node) && broad(node.type))) add(node, `service bag ${node.name.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file.ast)
  return findings
}
