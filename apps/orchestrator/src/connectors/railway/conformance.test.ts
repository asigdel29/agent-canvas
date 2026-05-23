import { runConnectorConformance } from '@agent-canvas/connector-core/conformance'
import { RailwayConnector } from './connector.js'

runConnectorConformance(new RailwayConnector())
