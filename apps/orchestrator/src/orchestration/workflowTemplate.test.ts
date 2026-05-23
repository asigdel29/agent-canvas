import { describe, expect, it } from 'vitest'
import {
	InMemoryWorkflowTemplateStore,
	type WorkflowTemplate,
	instantiateGoal,
} from './workflowTemplate.js'

function triageTemplate(): WorkflowTemplate {
	return {
		id: 'triage_linear_bugs',
		name: 'Triage bug-labeled Linear issues',
		description: 'When a Linear issue with label "bug" is created, draft a triage plan.',
		auto_triggers: [
			{
				provider: 'linear',
				event_type: 'issue_created',
				payload_equals: { labels: ['bug'] },
			},
		],
		required_tools: ['linear.list_issues', 'linear.update_issue', 'slack.post_message'],
		goal_template:
			'Triage Linear issue {{trigger.issue.identifier}}: "{{trigger.issue.title}}". ' +
			'Reproduce, file a fix plan, and post a summary to #eng.',
		target_room: 'origin',
	}
}

describe('InMemoryWorkflowTemplateStore', () => {
	it('lists registered templates', async () => {
		const store = new InMemoryWorkflowTemplateStore()
		store.register(triageTemplate())
		const all = await store.list()
		expect(all).toHaveLength(1)
		expect(all[0]!.id).toBe('triage_linear_bugs')
	})

	it('returns null for unknown ids', async () => {
		const store = new InMemoryWorkflowTemplateStore()
		expect(await store.get('missing')).toBeNull()
	})

	it('matchTrigger returns templates whose provider + event_type match', async () => {
		const store = new InMemoryWorkflowTemplateStore()
		store.register(triageTemplate())
		const matched = await store.matchTrigger('linear', 'issue_created', { labels: ['bug'] })
		expect(matched.map((t) => t.id)).toEqual(['triage_linear_bugs'])
	})

	it('matchTrigger filters by payload_equals when present', async () => {
		const store = new InMemoryWorkflowTemplateStore()
		store.register(triageTemplate())
		const noMatch = await store.matchTrigger('linear', 'issue_created', {
			labels: ['feature'],
		})
		expect(noMatch).toEqual([])
	})

	it('matchTrigger ignores non-matching providers and events', async () => {
		const store = new InMemoryWorkflowTemplateStore()
		store.register(triageTemplate())
		expect(await store.matchTrigger('github', 'issue_created', {})).toEqual([])
		expect(await store.matchTrigger('linear', 'issue_updated', {})).toEqual([])
	})

	it('payload_equals supports array containment, not strict equality', async () => {
		const store = new InMemoryWorkflowTemplateStore()
		store.register(triageTemplate())
		const matched = await store.matchTrigger('linear', 'issue_created', {
			labels: ['bug', 'urgent'], // contains 'bug'; should still match
		})
		expect(matched).toHaveLength(1)
	})
})

describe('instantiateGoal', () => {
	const t = triageTemplate()

	it('interpolates {{trigger.path}} placeholders', () => {
		const goal = instantiateGoal(t, {
			issue: { identifier: 'ENG-481', title: 'Login button stops responding' },
		})
		expect(goal).toContain('ENG-481')
		expect(goal).toContain('Login button stops responding')
	})

	it('leaves unresolved placeholders in place rather than erasing them', () => {
		const goal = instantiateGoal(t, { issue: { identifier: 'ENG-481' /* no title */ } })
		expect(goal).toContain('ENG-481')
		expect(goal).toContain('{{trigger.issue.title}}')
	})

	it('handles nested paths', () => {
		const t2: WorkflowTemplate = {
			...t,
			id: 'nested',
			goal_template: 'Hello {{trigger.user.profile.name}}',
		}
		const goal = instantiateGoal(t2, { user: { profile: { name: 'Anu' } } })
		expect(goal).toBe('Hello Anu')
	})
})
