import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig( {
	// relative asset paths: the build runs from any sub-path (GitHub Pages serves it under /tidewater/)
	base: './',
	plugins: [ basicSsl() ],
	build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
	server: { port: 5189, strictPort: true, host: '0.0.0.0' },
} );
