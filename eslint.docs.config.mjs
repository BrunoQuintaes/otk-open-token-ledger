/**
 * ESLint flat config that checks ONLY documentation comments (no style or logic rules), so it can be
 * applied to an existing codebase without touching anything else.
 *
 * What it requires (TSDoc/JSDoc standard):
 * - a file header comment with `@module` in every file;
 * - a doc comment on every exported function, class, method, interface, type alias, enum and exported const;
 * - `@param` for each parameter, `@returns` when the function returns a value, `@throws` when it throws;
 * - parameter names in the comment that match the code, and only known tags.
 *
 * Usage (from the repository root; the three packages are not in package.json, so install them without saving):
 *   npm install --no-save eslint@10.15.0 typescript-eslint@8.74.0 eslint-plugin-jsdoc@65.5.5
 *   npx eslint --config eslint.docs.config.mjs "src/**\/*.ts"
 *
 * @module eslint.docs.config
 */
import jsdoc from 'eslint-plugin-jsdoc';
import tseslint from 'typescript-eslint';

/** File globs checked by this config; tests and scripts included, since every file needs a header. */
const FILES = ['**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}'];

/**
 * Paths never checked: dependencies, build output, generated files, the byte-hashed reproduction package, and two
 * files that must stay byte-identical to the evaluated version: an empty test file, and a verbatim copy of an
 * external kit whose sha256 is checked by `test/h2eval/econ/econ_itens.test.ts`.
 */
const IGNORES = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/*.d.ts', 'reproducao/**', 'web/**',
  'test/unit/w7_stripe_billing.test.ts', 'test/h2eval/econ/paridade_h_kit_v3_1.mjs'];

/** Tags allowed besides the JSDoc defaults: TSDoc tags and `@module`. */
const EXTRA_TAGS = ['module', 'remarks', 'packageDocumentation', 'typeParam', 'defaultValue', 'privateRemarks', 'sealed', 'virtual', 'override', 'alpha', 'beta', 'experimental', 'internal', 'public', 'label', 'decorator', 'eventProperty'];

export default [
  { ignores: IGNORES },
  {
    files: FILES,
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    // typescript-eslint's plugin is registered with no rules on, only so existing
    // `eslint-disable @typescript-eslint/...` comments in the code do not raise "rule not found".
    plugins: { jsdoc, '@typescript-eslint': tseslint.plugin },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      // Every file starts with a header that says what it does; `@module` names it.
      'jsdoc/require-file-overview': ['error', { tags: { module: { initialCommentsOnly: false, mustExist: true, preventDuplicates: true } } }],
      // Every exported symbol is documented.
      'jsdoc/require-jsdoc': ['error', {
        publicOnly: true,
        require: { FunctionDeclaration: true, ClassDeclaration: true, MethodDefinition: true, ArrowFunctionExpression: true, FunctionExpression: true },
        contexts: ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'ExportNamedDeclaration > VariableDeclaration'],
        checkConstructors: false,
      }],
      'jsdoc/require-description': ['error', { contexts: ['FunctionDeclaration', 'ClassDeclaration', 'MethodDefinition', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration'] }],
      'jsdoc/require-param': ['error', { checkDestructured: false }],
      'jsdoc/require-param-description': 'error',
      'jsdoc/check-param-names': ['error', { checkDestructured: false }],
      'jsdoc/require-returns': ['error', { publicOnly: true }],
      'jsdoc/require-returns-description': 'error',
      'jsdoc/require-throws': 'error',
      'jsdoc/check-tag-names': ['error', { definedTags: EXTRA_TAGS }],
      // In TypeScript the type lives in the code, not in the comment.
      'jsdoc/no-types': ['warn', { contexts: ['any'] }],
    },
  },
];
