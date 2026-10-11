import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const baseline = JSON.parse(fs.readFileSync('docs/superpowers/plans/2026-10-11-structural-separation-baseline.json', 'utf8'))
const namesPath = 'shared/contracts/events/names.ts'
const names = ts.createSourceFile(namesPath, fs.readFileSync(namesPath, 'utf8'), ts.ScriptTarget.Latest, true)

describe('shared event-name contracts', () => {
  it('preserves the complete event list, spellings, and order from the frozen baseline', () => {
    const actual = []
    for (const statement of names.statements.filter(ts.isImportDeclaration)) {
      const familyPath = path.join('shared/contracts/events', statement.moduleSpecifier.text + '.ts')
      const family = ts.createSourceFile(familyPath, fs.readFileSync(familyPath, 'utf8'), ts.ScriptTarget.Latest, true)
      const declaration = family.statements.find(ts.isVariableStatement).declarationList.declarations[0]
      let values = declaration.initializer
      while (ts.isAsExpression(values)) values = values.expression
      actual.push(...values.elements.map(element => element.text))
    }
    expect(actual).toEqual(baseline.eventTypes)
  })

  it('keeps the event schema version and legacy envelope exports compatible', () => {
    const declarations = names.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations)
    const version = declarations.find(declaration => declaration.name.getText(names) === 'CORE_EVENT_SCHEMA_VERSION')
    expect(version?.initializer?.getText(names)).toBe(String(baseline.eventSchemaVersion))
    const facade = fs.readFileSync('core/events/envelope.ts', 'utf8')
    expect(facade).toContain("export { CORE_EVENT_SCHEMA_VERSION, CORE_EVENT_TYPES } from '../../shared/contracts/events/names'")
    expect(facade).toContain("export type { CoreEventType } from '../../shared/contracts/events/names'")
  })

  it('pins every payload and closed vocabulary to the approved extraction baseline', () => {
    const files = new Set(names.statements.filter(ts.isImportDeclaration).map(statement => path.join('shared/contracts/events', statement.moduleSpecifier.text + '.ts')))
    for (const file of fs.readdirSync('shared/contracts/events/vocabulary')) files.add(path.join('shared/contracts/events/vocabulary', file))
    const printer = ts.createPrinter({ removeComments: true })
    const signatures = []
    for (const file of [...files].sort()) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      for (const declaration of source.statements) {
        if (declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
          && (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration) || ts.isVariableStatement(declaration))) {
          signatures.push(file.replaceAll('\\', '/') + ':' + printer.printNode(ts.EmitHint.Unspecified, declaration, source))
        }
      }
    }
    const fingerprint = createHash('sha256').update(signatures.join('\n')).digest('hex')
    expect(fingerprint).toBe(baseline.eventPayloadContractsSha256)
  })
})
