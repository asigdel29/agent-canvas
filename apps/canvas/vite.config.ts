/**
 * Vite build and dev-server configuration for the canvas app.
 *
 * @author asigdel29
 */

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
	},
	build: {
		target: 'esnext',
		sourcemap: true,
	},
})
