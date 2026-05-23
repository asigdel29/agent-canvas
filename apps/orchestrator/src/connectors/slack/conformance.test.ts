import { runConnectorConformance } from '@agent-canvas/connector-core/conformance'
import { SlackConnector } from './connector.js'

runConnectorConformance(new SlackConnector())
