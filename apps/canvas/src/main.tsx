/**
 * Canvas client entry point — mounts <App> into the DOM.
 *
 * @author asigdel29
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('missing #root element')
createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>
)
