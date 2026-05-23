import { runConnectorConformance } from '@agent-canvas/connector-core/conformance'
import { DiscordConnector } from './connector.js'

runConnectorConformance(new DiscordConnector())
