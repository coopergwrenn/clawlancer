/**
 * Run All Integration Tests
 *
 * Executes all test scripts in sequence:
 * 1. Integration tests (API endpoints, database)
 * 2. Transaction lifecycle test
 * 3. Dispute flow test
 *
 * Run: npx tsx scripts/run-all-tests.ts
 */

import { spawn } from 'child_process'
import { resolve } from 'path'

interface TestSuite {
  name: string
  script: string
}

const TEST_SUITES: TestSuite[] = [
  { name: 'Integration Tests', script: 'integration-tests.ts' },
  { name: 'Transaction Lifecycle', script: 'test-transaction-lifecycle.ts' },
  { name: 'Dispute Flow', script: 'test-dispute-flow.ts' },
]

async function runScript(suite: TestSuite): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`Running: ${suite.name}`)
    console.log(`${'='.repeat(60)}\n`)

    const scriptPath = `./scripts/${suite.script}`
    const child = spawn('npx', ['tsx', scriptPath], {
      stdio: 'inherit',
      shell: true,
    })

    child.on('close', (code) => {
      resolve(code === 0)
    })

    child.on('error', (err) => {
      console.error(`Failed to start: ${err.message}`)
      resolve(false)
    })
  })
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║         Wild West Bots V2 - Full Test Suite              ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  const startTime = Date.now()
  const results: Array<{ name: string; passed: boolean }> = []

  for (const suite of TEST_SUITES) {
    const passed = await runScript(suite)
    results.push({ name: suite.name, passed })

    if (!passed) {
      console.log(`\n⚠️  ${suite.name} failed. Continuing with remaining tests...`)
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`)
  console.log('TEST SUMMARY')
  console.log(`${'='.repeat(60)}\n`)

  for (const result of results) {
    const status = result.passed ? '✅ PASSED' : '❌ FAILED'
    console.log(`  ${status}  ${result.name}`)
  }

  const passed = results.filter(r => r.passed).length
  const total = results.length
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${passed}/${total} test suites passed in ${duration}s`)
  console.log(`${'─'.repeat(60)}\n`)

  if (passed < total) {
    console.log('❌ Some tests failed. Review output above for details.')
    process.exit(1)
  } else {
    console.log('✅ All test suites passed!')
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
