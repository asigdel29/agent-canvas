/**
 * OnboardingWizard — first-run, three steps:
 *
 *   1. Welcome      what is this product, two-line pitch
 *   2. Connect      connect GitHub
 *   3. Done         summary + 'Enter canvas' button
 *
 * The wizard never blocks: the user can hit "Skip for now" on any
 * step and land on an empty canvas. We persist completion to
 * localStorage under ONBOARDING_KEY so a refresh after step 3 takes
 * them straight to the canvas.
 *
 * State machine is local; the parent receives the wizard output
 * (connected providers) via onComplete and is responsible for
 * forwarding it to the orchestrator.
 * @author asigdel29
 */

import { useState } from 'react'
import type { StarterProvider } from './EmptyState.js'

export const ONBOARDING_STORAGE_KEY = 'agent-canvas:onboarded'

export type OnboardingStep = 'welcome' | 'connect' | 'done'

export interface OnboardingResult {
	readonly providers: readonly StarterProvider[]
}

export interface OnboardingWizardProps {
	readonly displayName?: string | undefined
	readonly onComplete: (result: OnboardingResult) => void
	readonly onSkip: () => void
}

const PROVIDERS: { id: StarterProvider; label: string; tagline: string }[] = [
	{ id: 'github', label: 'GitHub', tagline: 'Issues, PRs, reviews' },
]

export function OnboardingWizard({ displayName, onComplete, onSkip }: OnboardingWizardProps) {
	const [step, setStep] = useState<OnboardingStep>('welcome')
	const [selectedProviders, setSelectedProviders] = useState<Set<StarterProvider>>(new Set())

	function finish() {
		try {
			window.localStorage.setItem(ONBOARDING_STORAGE_KEY, '1')
		} catch {
			// localStorage disabled; we proceed anyway and the user just
			// sees the wizard again next refresh.
		}
		onComplete({
			providers: Array.from(selectedProviders),
		})
	}

	function skip() {
		try {
			window.localStorage.setItem(ONBOARDING_STORAGE_KEY, '1')
		} catch {
			// ignore
		}
		onSkip()
	}

	return (
		<div
			role="main"
			style={{
				position: 'fixed',
				inset: 0,
				display: 'grid',
				placeItems: 'center',
				background: 'var(--surface)',
				color: 'var(--text-strong)',
			}}
		>
			<section
				style={{
					width: 'min(560px, 92vw)',
					padding: 'var(--space-6) var(--space-5)',
					background: 'var(--surface-elev)',
					border: '1px solid var(--border)',
					borderRadius: 'var(--radius-lg)',
					boxShadow: 'var(--shadow-popover)',
					display: 'grid',
					gap: 'var(--space-5)',
				}}
			>
				<StepIndicator current={step} />

				{step === 'welcome' && (
					<WelcomeStep
						displayName={displayName}
						onNext={() => setStep('connect')}
						onSkip={skip}
					/>
				)}
				{step === 'connect' && (
					<ConnectStep
						selected={selectedProviders}
						onToggle={(id) => {
							const next = new Set(selectedProviders)
							if (next.has(id)) next.delete(id)
							else next.add(id)
							setSelectedProviders(next)
						}}
						onNext={() => setStep('done')}
						onBack={() => setStep('welcome')}
						onSkip={skip}
					/>
				)}
				{step === 'done' && (
					<DoneStep
						providers={Array.from(selectedProviders)}
						onEnter={finish}
						onBack={() => setStep('connect')}
					/>
				)}
			</section>
		</div>
	)
}

function StepIndicator({ current }: { current: OnboardingStep }) {
	const order: OnboardingStep[] = ['welcome', 'connect', 'done']
	const index = order.indexOf(current)
	return (
		<div
			aria-label="Progress"
			style={{
				display: 'grid',
				gridTemplateColumns: 'repeat(3, 1fr)',
				gap: 4,
			}}
		>
			{order.map((s, i) => (
				<span
					key={s}
					style={{
						height: 3,
						borderRadius: 2,
						background: i <= index ? 'var(--accent)' : 'var(--border)',
						transition: 'background var(--motion-card) var(--ease-default)',
					}}
				/>
			))}
		</div>
	)
}

function WelcomeStep({
	displayName,
	onNext,
	onSkip,
}: {
	displayName?: string | undefined
	onNext: () => void
	onSkip: () => void
}) {
	return (
		<div style={{ display: 'grid', gap: 'var(--space-4)' }}>
			<header style={{ display: 'grid', gap: 'var(--space-2)' }}>
				<h1 style={{ margin: 0, fontSize: 'var(--font-24)', fontWeight: 500, letterSpacing: -0.2 }}>
					Welcome{displayName ? `, ${displayName}` : ''}.
				</h1>
				<p style={{ margin: 0, fontSize: 'var(--font-14)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
					Agent canvas is an infinite-canvas runner for cloud AI agents. You connect tools,
					drop agents on the canvas, and watch them work. Three quick steps and you're in.
				</p>
			</header>
			<Footer onPrimary={onNext} primaryLabel="Get started" onSkip={onSkip} />
		</div>
	)
}

function ConnectStep({
	selected,
	onToggle,
	onNext,
	onBack,
	onSkip,
}: {
	selected: Set<StarterProvider>
	onToggle: (id: StarterProvider) => void
	onNext: () => void
	onBack: () => void
	onSkip: () => void
}) {
	return (
		<div style={{ display: 'grid', gap: 'var(--space-4)' }}>
			<header style={{ display: 'grid', gap: 'var(--space-2)' }}>
				<h1 style={{ margin: 0, fontSize: 'var(--font-20)', fontWeight: 500 }}>
					Pick one or more tools to connect
				</h1>
				<p style={{ margin: 0, fontSize: 'var(--font-13)', color: 'var(--text-muted)' }}>
					You can add more after.
				</p>
			</header>
			<div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-2)' }}>
				{PROVIDERS.map((p) => (
					<ProviderTile
						key={p.id}
						label={p.label}
						tagline={p.tagline}
						selected={selected.has(p.id)}
						onClick={() => onToggle(p.id)}
					/>
				))}
			</div>
			<Footer
				onPrimary={onNext}
				primaryLabel={selected.size > 0 ? `Continue (${selected.size})` : 'Skip'}
				onSecondary={onBack}
				secondaryLabel="Back"
				onSkip={onSkip}
			/>
		</div>
	)
}

function ProviderTile({
	label,
	tagline,
	selected,
	onClick,
}: {
	label: string
	tagline: string
	selected: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={selected}
			style={{
				display: 'grid',
				gap: 2,
				justifyItems: 'flex-start',
				textAlign: 'left',
				padding: 'var(--space-3) var(--space-4)',
				background: selected ? 'var(--accent-soft)' : 'var(--surface-elev)',
				border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
				borderRadius: 'var(--radius-md)',
				color: 'var(--text-strong)',
				font: 'inherit',
				fontFamily: 'var(--font-ui)',
				cursor: 'pointer',
			}}
		>
			<span style={{ fontSize: 'var(--font-14)', fontWeight: 500 }}>{label}</span>
			<span style={{ fontSize: 'var(--font-12)', color: 'var(--text-muted)' }}>{tagline}</span>
		</button>
	)
}

function DoneStep({
	providers,
	onEnter,
	onBack,
}: {
	providers: readonly StarterProvider[]
	onEnter: () => void
	onBack: () => void
}) {
	return (
		<div style={{ display: 'grid', gap: 'var(--space-4)' }}>
			<header style={{ display: 'grid', gap: 'var(--space-2)' }}>
				<h1 style={{ margin: 0, fontSize: 'var(--font-20)', fontWeight: 500 }}>
					You're set.
				</h1>
				<p style={{ margin: 0, fontSize: 'var(--font-13)', color: 'var(--text-muted)' }}>
					Drop your first agent from the toolbar at the top of the canvas.
				</p>
			</header>
			<dl style={{ margin: 0, display: 'grid', gap: 'var(--space-2)' }}>
				<Row
					label="Tools queued"
					value={providers.length > 0 ? providers.join(', ') : 'none yet'}
				/>
			</dl>
			<Footer
				onPrimary={onEnter}
				primaryLabel="Enter canvas"
				onSecondary={onBack}
				secondaryLabel="Back"
			/>
		</div>
	)
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div
			style={{
				display: 'grid',
				gridTemplateColumns: '140px 1fr',
				alignItems: 'baseline',
				padding: 'var(--space-2) var(--space-3)',
				background: 'var(--surface-sunk)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-md)',
				fontSize: 'var(--font-13)',
			}}
		>
			<dt style={{ color: 'var(--text-muted)', margin: 0 }}>{label}</dt>
			<dd style={{ margin: 0, color: 'var(--text-strong)', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-12)' }}>
				{value}
			</dd>
		</div>
	)
}

function Footer({
	onPrimary,
	primaryLabel,
	onSecondary,
	secondaryLabel,
	onSkip,
}: {
	onPrimary: () => void
	primaryLabel: string
	onSecondary?: () => void
	secondaryLabel?: string
	onSkip?: () => void
}) {
	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: 'var(--space-2)',
			}}
		>
			<div>
				{onSkip && (
					<button
						type="button"
						onClick={onSkip}
						style={{
							background: 'transparent',
							border: 'none',
							padding: 0,
							color: 'var(--text-muted)',
							font: 'inherit',
							fontFamily: 'var(--font-ui)',
							fontSize: 'var(--font-12)',
							cursor: 'pointer',
							textDecoration: 'underline',
						}}
					>
						Skip for now
					</button>
				)}
			</div>
			<div style={{ display: 'flex', gap: 'var(--space-2)' }}>
				{onSecondary && (
					<button
						type="button"
						onClick={onSecondary}
						style={{
							height: 32,
							padding: '0 var(--space-4)',
							background: 'transparent',
							color: 'var(--text-strong)',
							border: '1px solid var(--border)',
							borderRadius: 'var(--radius-md)',
							font: 'inherit',
							fontFamily: 'var(--font-ui)',
							fontSize: 'var(--font-13)',
							cursor: 'pointer',
						}}
					>
						{secondaryLabel ?? 'Back'}
					</button>
				)}
				<button
					type="button"
					onClick={onPrimary}
					style={{
						height: 32,
						padding: '0 var(--space-4)',
						background: 'var(--accent)',
						color: 'var(--text-on-accent)',
						border: 'none',
						borderRadius: 'var(--radius-md)',
						font: 'inherit',
						fontFamily: 'var(--font-ui)',
						fontSize: 'var(--font-13)',
						fontWeight: 500,
						cursor: 'pointer',
					}}
				>
					{primaryLabel}
				</button>
			</div>
		</div>
	)
}
