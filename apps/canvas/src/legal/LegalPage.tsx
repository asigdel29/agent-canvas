/**
 * LegalPage — renders a static markdown document (ToS or
 * Privacy) at a dedicated route. Standalone surface, no shell,
 * so a Google crawler or a "view the terms" link drop lands on
 * a clean page.
 *
 * Markdown rendering is minimal and hand-rolled (no
 * react-markdown dep) because the documents are well-formed,
 * the bundle stays smaller, and we don't need GFM features.
 * Supports: # ## ### headings, paragraphs, bullet lists, bold,
 * italic, inline code, and code blocks. Anything fancier (tables,
 * embedded HTML, footnotes) renders verbatim.
 *
 * Visual model: max-width prose, the same dark surface as the
 * canvas, with a back link to the landing page at the top.
 */

import { useMemo } from 'react'

export interface LegalPageProps {
	readonly title: string
	readonly markdown: string
}

export function LegalPage({ title, markdown }: LegalPageProps) {
	const blocks = useMemo(() => parseMarkdown(markdown), [markdown])
	return (
		<div
			role="main"
			style={{
				position: 'fixed',
				inset: 0,
				overflowY: 'auto',
				background: 'var(--surface)',
				color: 'var(--text-strong)',
				padding: 'var(--space-7) var(--space-5)',
			}}
		>
			<article
				style={{
					maxWidth: 720,
					margin: '0 auto',
					fontFamily: 'var(--font-ui)',
					fontSize: 'var(--font-14)',
					lineHeight: 1.7,
				}}
			>
				<nav style={{ marginBottom: 'var(--space-5)' }}>
					<a
						href="/"
						style={{
							fontSize: 'var(--font-12)',
							color: 'var(--accent)',
							textDecoration: 'none',
						}}
					>
						← Back to agent canvas
					</a>
				</nav>
				<h1
					style={{
						fontSize: 'var(--font-32)',
						fontWeight: 500,
						letterSpacing: -0.2,
						margin: '0 0 var(--space-5)',
					}}
				>
					{title}
				</h1>
				{blocks.map((block, i) => (
					<RenderBlock key={i} block={block} />
				))}
				<footer
					style={{
						marginTop: 'var(--space-7)',
						paddingTop: 'var(--space-5)',
						borderTop: '1px solid var(--border)',
						display: 'flex',
						justifyContent: 'space-between',
						alignItems: 'baseline',
						fontSize: 'var(--font-12)',
						color: 'var(--text-muted)',
					}}
				>
					<span>agent-canvas</span>
					<a href="/" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
						Return to app
					</a>
				</footer>
			</article>
		</div>
	)
}

/* -------------------------------------------------------------- *
 * Tiny markdown parser                                            *
 * -------------------------------------------------------------- */

type Block =
	| { kind: 'h1'; text: string }
	| { kind: 'h2'; text: string }
	| { kind: 'h3'; text: string }
	| { kind: 'p'; lines: string[] }
	| { kind: 'ul'; items: string[] }

function parseMarkdown(src: string): Block[] {
	const lines = src.replace(/\r\n/g, '\n').split('\n')
	const out: Block[] = []
	let i = 0
	while (i < lines.length) {
		const raw = lines[i]!
		const line = raw.trimEnd()
		if (line === '') {
			i += 1
			continue
		}
		if (line.startsWith('### ')) {
			out.push({ kind: 'h3', text: line.slice(4) })
			i += 1
			continue
		}
		if (line.startsWith('## ')) {
			out.push({ kind: 'h2', text: line.slice(3) })
			i += 1
			continue
		}
		if (line.startsWith('# ')) {
			// The page title is rendered separately; skip first '# ' line.
			if (out.length === 0) {
				i += 1
				continue
			}
			out.push({ kind: 'h2', text: line.slice(2) })
			i += 1
			continue
		}
		if (line.startsWith('- ') || line.startsWith('* ')) {
			const items: string[] = []
			while (i < lines.length) {
				const candidate = lines[i]!.trimEnd()
				if (candidate.startsWith('- ') || candidate.startsWith('* ')) {
					items.push(candidate.slice(2))
					i += 1
				} else {
					break
				}
			}
			out.push({ kind: 'ul', items })
			continue
		}
		// Paragraph: collect consecutive non-empty, non-heading lines.
		const paraLines: string[] = []
		while (i < lines.length) {
			const candidate = lines[i]!.trimEnd()
			if (
				candidate === '' ||
				candidate.startsWith('#') ||
				candidate.startsWith('- ') ||
				candidate.startsWith('* ')
			)
				break
			paraLines.push(candidate)
			i += 1
		}
		out.push({ kind: 'p', lines: paraLines })
	}
	return out
}

function RenderBlock({ block }: { block: Block }) {
	if (block.kind === 'h2') {
		return (
			<h2
				style={{
					fontSize: 'var(--font-20)',
					fontWeight: 500,
					letterSpacing: -0.1,
					margin: 'var(--space-5) 0 var(--space-3)',
				}}
			>
				{renderInline(block.text)}
			</h2>
		)
	}
	if (block.kind === 'h3') {
		return (
			<h3
				style={{
					fontSize: 'var(--font-16)',
					fontWeight: 500,
					margin: 'var(--space-4) 0 var(--space-2)',
				}}
			>
				{renderInline(block.text)}
			</h3>
		)
	}
	if (block.kind === 'h1') {
		return (
			<h1
				style={{
					fontSize: 'var(--font-24)',
					fontWeight: 500,
					letterSpacing: -0.2,
					margin: 'var(--space-5) 0 var(--space-3)',
				}}
			>
				{renderInline(block.text)}
			</h1>
		)
	}
	if (block.kind === 'ul') {
		return (
			<ul
				style={{
					margin: 'var(--space-2) 0 var(--space-3)',
					paddingLeft: 'var(--space-5)',
					color: 'var(--text-strong)',
				}}
			>
				{block.items.map((item, i) => (
					<li key={i} style={{ marginBottom: 4 }}>
						{renderInline(item)}
					</li>
				))}
			</ul>
		)
	}
	return (
		<p
			style={{
				margin: '0 0 var(--space-3)',
				color: 'var(--text-strong)',
			}}
		>
			{block.lines.map((l, i) => (
				<span key={i}>
					{renderInline(l)}
					{i < block.lines.length - 1 && ' '}
				</span>
			))}
		</p>
	)
}

/**
 * Inline-style markdown for **bold**, _italic_, and `code`.
 * Hand-rolled tokenizer so we don't bring in a markdown lib.
 * Recognized in left-to-right order with no nesting.
 */
function renderInline(text: string): React.ReactNode {
	const pieces: React.ReactNode[] = []
	let rest = text
	let i = 0
	while (rest.length > 0) {
		const bold = rest.indexOf('**')
		const code = rest.indexOf('`')
		const ital = rest.indexOf('_')
		const next = [
			['bold', bold] as const,
			['code', code] as const,
			['ital', ital] as const,
		]
			.filter(([, idx]) => idx >= 0)
			.sort((a, b) => a[1] - b[1])[0]
		if (!next) {
			pieces.push(<span key={i++}>{rest}</span>)
			break
		}
		const [kind, idx] = next
		if (idx > 0) {
			pieces.push(<span key={i++}>{rest.slice(0, idx)}</span>)
		}
		const marker = kind === 'bold' ? '**' : kind === 'code' ? '`' : '_'
		const close = rest.indexOf(marker, idx + marker.length)
		if (close < 0) {
			pieces.push(<span key={i++}>{rest.slice(idx)}</span>)
			break
		}
		const inner = rest.slice(idx + marker.length, close)
		if (kind === 'bold') {
			pieces.push(
				<strong key={i++} style={{ fontWeight: 600 }}>
					{inner}
				</strong>
			)
		} else if (kind === 'ital') {
			pieces.push(
				<em key={i++} style={{ fontStyle: 'italic' }}>
					{inner}
				</em>
			)
		} else {
			pieces.push(
				<code
					key={i++}
					style={{
						fontFamily: 'var(--font-mono)',
						fontSize: 'var(--font-12)',
						padding: '1px 6px',
						background: 'var(--surface-sunk)',
						borderRadius: 4,
					}}
				>
					{inner}
				</code>
			)
		}
		rest = rest.slice(close + marker.length)
	}
	return pieces
}
