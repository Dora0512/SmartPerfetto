// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Canonical source→frontend transforms for the analysis quality contracts.
 *
 * The generator and the sync checker both have to reduce a backend contract
 * module to the fragment that belongs in the generated frontend types. They
 * used to hold private copies of those rules, and they drifted: the generator
 * rewrote `SourceUseDecisionV1` to `Record<string, unknown>` (the frontend has
 * no `sourceUseDecision` module) while the checker compared against the
 * untransformed source. The check could then never pass, which left
 * `./scripts/start-dev.sh` failing at its type-sync gate.
 *
 * Both scripts import from here so the two can no longer disagree.
 */

import ts from 'typescript';

const TRACE_TIMESTAMP_ALIAS = /export type TraceTimestampNs = string \| number;\n\n/;

/**
 * `conclusionContract.ts` as it appears in the generated frontend types.
 *
 * Backend-only imports are dropped and the types they brought in become
 * `Record<string, unknown>`: the frontend never needs their shape, and copying
 * the codebase modules across the boundary would pull source-access contracts
 * into the UI bundle.
 */
export function conclusionContractFragment(content: string): string {
  return inlineConstTypeQueries(content, typeDeclarations(content))
    .replace(/SourceUseDecisionV1/g, 'Record<string, unknown>')
    .replace(/SourceReferenceV1/g, 'Record<string, unknown>')
    .replace(/SourceClaimBindingV1/g, 'Record<string, unknown>');
}

/**
 * Emit declarations, never backend imports, parsers or proof-producing code.
 * A module-private declaration is emitted only when an emitted one refers to
 * it: the frontend compiles with unused-local checks, and a private helper type
 * of the backend parser has no reader there.
 */
function typeDeclarations(content: string): string {
  const source = ts.createSourceFile('contract.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = source.statements.filter(
    (statement): statement is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement));
  const isExported = (declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration) =>
    Boolean(declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  const included = new Set(declarations.filter(isExported));
  for (let grew = true; grew;) {
    grew = false;
    const emitted = [...included].map(declaration => declaration.getText(source)).join('\n');
    for (const declaration of declarations) {
      if (included.has(declaration) || !new RegExp(`\\b${declaration.name.text}\\b`).test(emitted)) continue;
      included.add(declaration);
      grew = true;
    }
  }
  return declarations
    .filter(declaration => included.has(declaration))
    .map(declaration => declaration.getFullText(source).trim())
    .join('\n\n');
}

/**
 * The frontend gets types, not the backend's runtime lists, so a type read off
 * a `const` is spelled out from that const's own string literals:
 *   `(typeof LIST)[number]`          -> the list's values
 *   `keyof typeof TABLE`             -> the table's keys
 *   `typeof TABLE[Key][number]`      -> every value of every key's list
 * A const that is not built from string literals fails the generation rather
 * than widening the emitted type.
 */
function inlineConstTypeQueries(content: string, declarations: string): string {
  const source = ts.createSourceFile('contract.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const unwrap = (node: ts.Expression | undefined): ts.Expression | undefined => {
    let current = node;
    while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current))) current = current.expression;
    return current;
  };
  // Only the consts a type actually reads have to have this shape; any other
  // const of the module is left alone.
  const stringList = (node: ts.Expression | undefined): string[] | undefined => {
    const list = unwrap(node);
    if (!list || !ts.isArrayLiteralExpression(list)) return undefined;
    const values = list.elements.filter(ts.isStringLiteral).map(element => element.text);
    return values.length === list.elements.length ? values : undefined;
  };
  const lists = new Map<string, string[]>();
  const tables = new Map<string, Map<string, string[]>>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      const list = stringList(declaration.initializer);
      if (list) {
        lists.set(name, list);
        continue;
      }
      const table = unwrap(declaration.initializer);
      if (!table || !ts.isObjectLiteralExpression(table)) continue;
      const entries = new Map<string, string[]>();
      for (const property of table.properties) {
        const values = ts.isPropertyAssignment(property)
          && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          ? stringList(property.initializer) : undefined;
        if (!values) break;
        entries.set((property as ts.PropertyAssignment).name.getText(source).replace(/^'|'$/g, ''), values);
      }
      if (entries.size === table.properties.length) tables.set(name, entries);
    }
  }
  const union = (values: Iterable<string>) => [...new Set(values)].map(value => `'${value}'`).join(' | ');
  const known = (map: Map<string, unknown>, name: string) => {
    if (!map.has(name)) throw new Error(`${name} is not a declared string list or table`);
  };
  return declarations
    .replace(/typeof ([A-Za-z_][A-Za-z0-9_]*)\[[A-Za-z_][A-Za-z0-9_]*\]\[number\]/g, (_match, name: string) => {
      known(tables, name);
      return union([...tables.get(name)!.values()].flat());
    })
    .replace(/keyof typeof ([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
      known(tables, name);
      return union(tables.get(name)!.keys());
    })
    .replace(/\(typeof ([A-Za-z_][A-Za-z0-9_]*)\)\[number\]/g, (_match, name: string) => {
      known(lists, name);
      return union(lists.get(name)!);
    });
}

/** Referenced contract types are concatenated into the same generated module. */
export function verbatimContractFragment(content: string): string {
  return typeDeclarations(content);
}

/**
 * `criticalPathContract.ts` as it appears in the generated frontend types: its
 * id unions, written `(typeof LIST)[number]` on the backend, are spelled out.
 */
export function criticalPathContractFragment(content: string): string {
  return inlineConstTypeQueries(content, typeDeclarations(content));
}

/**
 * `identityContract.ts` shares `TraceTimestampNs` with the evidence contract,
 * and the generated frontend types concatenate both into one file.
 */
export function identityContractFragment(content: string): string {
  return typeDeclarations(content).replace(TRACE_TIMESTAMP_ALIAS, '');
}

/** Per-file SPDX headers are emitted once at the top of the generated file. */
export function externalIssueReportingFragment(content: string): string {
  return content
    .trim()
    .replace(/^\/\/ SPDX-License-Identifier:[^\n]*\n/, '')
    .replace(/^\/\/ Copyright[^\n]*\n/, '')
    .replace(/^\/\/ This file[^\n]*\n\n/, '');
}

/** Sources needed by the serialized fields on AnalysisCompletedEvent. */
export const ANALYSIS_COMPLETED_PUBLIC_TYPE_PATHS = [
  'types/analysisDelivery.ts',
  'types/sceneTimeline.ts',
  'types/analysisInvestigationAssessment.ts',
  'services/evidence/investigationEvidenceLedger.ts',
  'services/evidence/evidenceCapture.ts',
  'agentRuntime/analysisTurnIntent.ts',
  'agentRuntime/runtimeKinds.ts',
  'agentRuntime/intentTransport.ts',
  'agentv3/types.ts',
  'services/codebase/sourceUseDecision.ts',
  'services/codebase/sourceClaimVerifier.ts',
] as const;

/** Only reachable type declarations cross the boundary, never runtime code. */
export function analysisCompletedPublicTypeFragment(eventContent: string, contents: readonly string[]): string {
  const declarations = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  const constants = new Map<string, ts.Expression>();
  for (const content of contents) {
    const source = ts.createSourceFile('public-contract.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        declarations.set(statement.name.text, statement);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  const literalType = (expression: ts.Expression, seen = new Set<string>()): ts.TypeNode => {
    if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) return literalType(expression.expression, seen);
    if (ts.isIdentifier(expression)) {
      const initializer = constants.get(expression.text);
      if (!initializer || seen.has(expression.text)) throw new Error(`Unresolved public type constant: ${expression.text}`);
      return literalType(initializer, new Set([...seen, expression.text]));
    }
    if (ts.isStringLiteral(expression)) return ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(expression.text));
    if (ts.isNumericLiteral(expression)) return ts.factory.createLiteralTypeNode(ts.factory.createNumericLiteral(expression.text));
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return ts.factory.createLiteralTypeNode(ts.factory.createTrue());
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return ts.factory.createLiteralTypeNode(ts.factory.createFalse());
    if (ts.isArrayLiteralExpression(expression)) return ts.factory.createTupleTypeNode(expression.elements.map(element => literalType(element, seen)));
    throw new Error('Public type queries must reference literal constants');
  };
  const constantType = (name: ts.EntityName): ts.TypeNode => {
    if (!ts.isIdentifier(name) || !constants.has(name.text)) throw new Error('Unresolved public type query');
    return literalType(constants.get(name.text)!);
  };
  const pending: string[] = [];
  const eventSource = ts.createSourceFile('dataContract.ts', eventContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const event = eventSource.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'AnalysisCompletedEvent');
  if (!event) throw new Error('Missing AnalysisCompletedEvent public contract');
  const collectRoots = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node) && node.qualifier && ts.isIdentifier(node.qualifier) && declarations.has(node.qualifier.text)) {
      pending.push(node.qualifier.text);
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && declarations.has(node.typeName.text)) {
      pending.push(node.typeName.text);
    }
    ts.forEachChild(node, collectRoots);
  };
  collectRoots(event);
  const emitted = new Set<string>();
  const parts: string[] = [];
  const printer = ts.createPrinter({newLine: ts.NewLineKind.LineFeed});
  for (let index = 0; index < pending.length; index++) {
    const name = pending[index];
    if (emitted.has(name)) continue;
    const declaration = declarations.get(name);
    if (!declaration) throw new Error(`Missing public type declaration: ${name}`);
    emitted.add(name);
    const transformed = ts.transform(declaration, [context => root => {
      const visit: ts.Visitor = node => {
        if (ts.isIndexedAccessTypeNode(node) && ts.isTypeQueryNode(node.objectType) &&
          node.indexType.kind === ts.SyntaxKind.NumberKeyword) {
          const tuple = constantType(node.objectType.exprName);
          if (!ts.isTupleTypeNode(tuple)) throw new Error('Public numeric type index requires a literal tuple');
          return ts.factory.createUnionTypeNode(tuple.elements as readonly ts.TypeNode[]);
        }
        if (ts.isTypeQueryNode(node)) return constantType(node.exprName);
        const referencedName = ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) ? node.typeName.text
          : ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined;
        if (referencedName && declarations.has(referencedName)) pending.push(referencedName);
        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitNode(root, visit) as typeof root;
    }]);
    parts.push(printer.printNode(ts.EmitHint.Unspecified, transformed.transformed[0], declaration.getSourceFile()).trim());
    transformed.dispose();
  }
  return parts.join('\n\n');
}

/** Exact event transform shared by generation and sync checking. */
export function analysisCompletedContractFragment(content: string): string {
  const start = content.indexOf('export interface AnalysisCompletedFinding {');
  const end = content.indexOf('/**\n * Union type for all SSE events', start);
  if (start < 0 || end < 0) throw new Error('Unable to extract AnalysisCompletedEvent from backend data contract');
  return content.slice(start, end).trim()
    .replace(/import\('\.\.\/agent\/core\/conclusionContract'\)\.ConclusionContract/g, 'ConclusionContract')
    .replace(/import\('\.\/evidenceContract'\)\.ClaimSupportV1/g, 'ClaimSupportV1')
    .replace(/import\('\.\/claimVerification'\)\.ClaimVerificationResult/g, 'ClaimVerificationResult')
    .replace(/import\('\.\/identityContract'\)\.IdentityResolutionV1/g, 'IdentityResolutionV1')
    .replace(/import\('\.\.\/agent\/core\/orchestratorTypes'\)\.QuickRunReceipt/g, 'QuickRunReceipt')
    .replace(/import\('\.\.\/agent\/scene\/types'\)\.SmartScenePreviewPayload/g, 'Record<string, unknown>')
    .replace(/import\('\.\.\/assistant\/contracts\/assistantResultContract'\)\.AssistantResultContract/g, 'Record<string, unknown>')
    .replace(/import\('\.\.\/agentRuntime\/analysisTurnIntent'\)\.AnalysisTurnIntent/g, 'AnalysisTurnIntent')
    .replace(/import\('\.\/analysisDelivery'\)\.(AnalysisCompletion|AnalysisOutputOrigin|AnalysisRuntimeAppendix|FinalReportAssessment|AnalysisDeliveryAssurance)/g, '$1')
    .replace(/import\('\.\/analysisInvestigationAssessment'\)\.FinalInvestigationAssessment/g, 'FinalInvestigationAssessment')
    .replace(/import\('\.\.\/services\/codebase\/sourceUseDecision'\)\.SourceUseDecisionV1/g, 'SourceUseDecisionV1')
    .replace(/import\('\.\.\/services\/codebase\/sourceClaimVerifier'\)\.SourceClaimVerificationResult/g, 'SourceClaimVerificationResult')
    .replace(/Omit<\s*import\('\.\.\/agentv3\/sessionStateSnapshot'\)\.ComparisonReportSection,\s*'html'\s*>\s*&\s*\{html\?: string\}/g, 'Record<string, unknown>');
}
