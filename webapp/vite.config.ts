import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/salot_bot/',
  plugins: [react()],
  // Карта соответствия сжатого кода исходным файлам — без неё ошибка на
  // реальном телефоне показывает только позицию в сжатом файле, по которой
  // невозможно понять, что именно сломалось
  build: {
    sourcemap: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
