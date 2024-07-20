import { setDefaultResultOrder } from 'node:dns'
import anyTest from 'ava'
import { NEAR, Worker, parseNEAR } from 'near-workspaces'
import { oneDay } from './constants/index.js'
import secondsToNanoseconds from './helpers/secondsToNanoseconds.js'
import setupFinalizeSession from './helpers/setupFinalizeSession.js'
import setupStakes from './helpers/setupStakes.js'
setDefaultResultOrder('ipv4first') // temp fix for node >v17

const test = anyTest

test.before(async (t) => {
  // biome-ignore lint: reason
  const worker = (t.context.worker = await Worker.init({}))

  // linear-protocol.testnet
  const root = worker.rootAccount
  const contract = await root.createSubAccount('test-account')
  const vzg = await root.createSubAccount('vzg')
  const alice = await root.createSubAccount('alice')
  const bob = await root.createSubAccount('bob')

  await contract.deploy(
    process.argv[2], // Path to the compiled contract .wasm file
  )
  await root.call(contract.accountId, 'init', {
    // refFinance: 'ref-finance.testnet',
    // yieldSource: 'linear-protocol.testnet',
    yieldSource: 'storage.herewallet.testnet',
    // yieldSource: 'storage.herewallet.near',
  })

  t.context.accounts = { root, contract, vzg, alice, bob }
})

test.afterEach.always(async (t) => {
  await t.context.worker.tearDown().catch((error) => {
    console.log('Failed to stop the Sandbox:', error)
  })
})

test('initial contract state', async (t) => {
  const { contract, root } = t.context.accounts
  const currentSessionId = await contract.view('getCurrentSessionId')
  const admin = await contract.view('getAdmin')
  const yieldSource = await contract.view('getYieldSource')

  t.is(admin, root.accountId)
  t.is(currentSessionId, '')
  t.is(yieldSource, 'fuck')
})

test('start session', async (t) => {
  const { root, contract } = t.context.accounts
  // const twoDays = secondsToNanoseconds(oneDay * 2)
  const halfDay = secondsToNanoseconds(oneDay / 2)

  await root.call(contract, 'startSession', { duration: halfDay, countOfWinNumbers: 1 })
  const currentSessionId = await contract.view('getCurrentSessionId', {})

  t.is(currentSessionId, '0')
  const session = await contract.view('getSession', { sessionId: currentSessionId })

  t.truthy(session)
})

test('stake', async (t) => {
  await setupStakes(t)
})

test('finalize session', async (t) => {
  await setupFinalizeSession(t)
})

test('claim rewards', async (t) => {
  const { root, contract, vzg, alice, bob, currentSessionId } = await setupFinalizeSession(t)

  // return
  const vzgBalanceBeforeClaim = (await vzg.balance()).available.toHuman()
  const aliceBalanceBeforeClaim = (await alice.balance()).available.toHuman()
  const bobBalanceBeforeClaim = (await bob.balance()).available.toHuman()

  console.log({
    vzgBalanceBeforeClaim,
    aliceBalanceBeforeClaim,
    bobBalanceBeforeClaim,
  })

  const vzgClaim = await vzg.call(contract, 'claim', { sessionId: currentSessionId })
  const aliceClaim = await alice.call(contract, 'claim', { sessionId: currentSessionId })
  const bobClaim = await bob.call(contract, 'claim', { sessionId: currentSessionId })

  // await t.context.worker.provider.fastForward(5)

  const vzgBalanceAfterClaim = (await vzg.balance()).available.toHuman()
  const aliceBalanceAfterClaim = (await alice.balance()).available.toHuman()
  const bobBalanceAfterClaim = (await bob.balance()).available.toHuman()

  console.log({
    vzgBalanceAfterClaim,
    aliceBalanceAfterClaim,
    bobBalanceAfterClaim,
  })

  const ticketRangeBeforeClaim = await contract.view('getPlayerTicketsRange', {})
  t.log(`Ticket Range Before Claim: ${ticketRangeBeforeClaim}`)

  await root.call(contract, 'claim', {})

  const player = await contract.view('sessions', { key: '0', player: root.accountId })
  t.true(player.isClaimed)

  const contractReward = await contract.view('contractReward', {})
  t.log(`Contract Reward: ${contractReward}`)
})
