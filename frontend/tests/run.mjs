// 领域测试入口：先用 esbuild JS API 打包（自动解析本机平台的二进制），再运行。
// 直接用 .bin/esbuild 会在跨平台复制的 node_modules 上踩到错误平台的二进制。
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('node_modules/.cache', { recursive: true })

await build({
  entryPoints: ['tests/consultation-service.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@': './src' },
  outfile: 'node_modules/.cache/consultation-service.test.mjs',
  logLevel: 'warning',
})

const result = spawnSync(process.execPath, ['node_modules/.cache/consultation-service.test.mjs'], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
