/**
 * Tests for conformance.
 *
 * @author asigdel29
 */

import { runConnectorConformance } from '@agent-canvas/connector-core/conformance'
import { GitHubConnector } from './connector.js'

runConnectorConformance(new GitHubConnector())
