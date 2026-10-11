import ts from 'typescript'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export const sourceRoots = ['core', 'freya', 'electron', 'src', 'shared', 'runtimes', 'scripts/architecture']
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/
export const slash = path => path.replaceAll('\\', '/')
export const hash = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex')

function loadSource(root, path) {
  const name = slash(relative(root, path))
  const text = readFileSync(path, 'utf8')
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return { name, path: resolve(path), ast, text, lines: substantiveLines(ast), hash: hash(text) }
}

export function substantiveLines(sourceFile) {
  const occupied = new Set()
  const lines = sourceFile.text.split(/\r?\n/)
  function visit(node) {
    // Parsed tokens preserve template/regex context. A raw scanner does not.
    if (node.kind === ts.SyntaxKind.EndOfFileToken || (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)) return
    if (!ts.isToken(node)) {
      for (const child of node.getChildren(sourceFile)) visit(child)
      return
    }
    const begin = node.getStart(sourceFile)
    const start = sourceFile.getLineAndCharacterOfPosition(begin).line
    const end = sourceFile.getLineAndCharacterOfPosition(Math.max(begin, node.getEnd() - 1)).line
    for (let line = start; line <= end; line++) {
      if (lines[line]?.trim()) occupied.add(line)
    }
  }
  visit(sourceFile)
  return occupied.size
}

export function readSources(root) {
  const files = new Map()
  function visit(path) {
    if (!existsSync(path)) return
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Source symlink is unsupported: ${path}/${entry.name}`)
      if (entry.isDirectory() && !['node_modules', 'dist', 'dist-electron', '.git'].includes(entry.name)) visit(join(path, entry.name))
      else if (entry.isFile() && sourceExtension.test(entry.name)) add(join(path, entry.name))
    }
  }
  function add(path) {
    const file = loadSource(root, path)
    files.set(file.name, file)
  }
  for (const directory of sourceRoots) visit(join(root, directory))
  const entry = join(root, 'scripts/check-architecture.mjs')
  if (existsSync(entry)) add(entry)
  return files
}

export function importSpecifiers(ast) {
  const imports = []
  function add(expression, typeOnly = false) {
    if (expression && (ts.isStringLiteralLike(expression))) imports.push({ specifier: expression.text, typeOnly })
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, !!node.importClause?.isTypeOnly || !!(node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && !node.importClause.name && node.importClause.namedBindings.elements.length && node.importClause.namedBindings.elements.every(item => item.isTypeOnly)))
    if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, !!node.isTypeOnly || !!(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every(item => item.isTypeOnly)))
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, !!node.isTypeOnly)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, true)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return imports
}

export function buildGraph(root, files) {
  const edges = new Map()
  const unresolved = []
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, baseUrl: root, paths: { '@/*': ['src/*'] } }
  for (const file of files.values()) {
    for (const item of importSpecifiers(file.ast)) {
      const local = item.specifier.startsWith('.') || item.specifier.startsWith('@/')
      if (!local) continue
      const resolved = ts.resolveModuleName(item.specifier, file.path, options, ts.sys).resolvedModule?.resolvedFileName
      if (!resolved) {
        // Assets are not module dependency edges; missing source modules must fail closed.
        if (!/\.(?:css|scss|png|jpe?g|svg|webp|gif|woff2?|mp3|wav|mp4)(?:\?.*)?$/.test(item.specifier)) unresolved.push(`${file.name}: ${item.specifier}`)
        continue
      }
      const target = slash(relative(root, resolved))
      if (target.startsWith('../') || target.includes('/node_modules/')) {
        unresolved.push(`${file.name}: local import escapes repository: ${item.specifier}`)
        continue
      }
      const key = `${file.name} -> ${target}`
      // Map iteration visits newly discovered modules, closing the local graph.
      if (sourceExtension.test(target) && !files.has(target)) files.set(target, loadSource(root, resolved))
      const previous = edges.get(key)
      edges.set(key, { key, from: file.name, to: target, typeOnly: item.typeOnly && (!previous || previous.typeOnly) })
    }
  }
  return { edges: [...edges.values()].sort((a, b) => a.key.localeCompare(b.key)), unresolved }
}
