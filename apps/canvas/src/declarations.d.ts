/**
 * Ambient module declarations for non-code assets imported for their
 * side effects.
 *
 * Vite resolves `import 'foo.css'` at build time, but the TypeScript
 * project (`tsc -b`, used by the typecheck and production-build steps)
 * needs a type for the specifier or it errors with TS2882. One wildcard
 * declaration covers every stylesheet import, whether package-relative
 * (`tldraw/tldraw.css`) or file-relative (`./styles.css`).
 *
 * @author asigdel29
 */

declare module '*.css'
