import { parseNEAR } from 'near-workspaces'
import { oneDay } from '../constants/index.js'
import secondsToNanoseconds from './secondsToNanoseconds.js'

// Helper function to set up stakes
export default async function setupStakes(t) {
  const { root, contract, vzg, alice, bob } = t.context.accounts

  const duration = secondsToNanoseconds((oneDay / 1000).toFixed())
  await root.call(contract, 'startSession', { duration, countOfWinNumbers: 1 })
  const currentSessionId = await contract.view('getCurrentSessionId', {})

  const deposit1 = parseNEAR('1 near')
  const deposit2 = parseNEAR('2 near')
  const deposit3 = parseNEAR('3 near')

  // User 1 stakes
  const stakeTransactionTime1 = BigInt(
    await vzg.call(contract, 'stake', {}, { attachedDeposit: deposit1 }),
  )

  // User 2 stakes
  const stakeTransactionTime2 = BigInt(
    await alice.call(contract, 'stake', {}, { attachedDeposit: deposit2 }),
  )

  // User 3 stakes
  const stakeTransactionTime3 = BigInt(
    await bob.call(contract, 'stake', {}, { attachedDeposit: deposit3 }),
  )

  const yieldSource = await contract.view('getYieldSource')
  const balanceOf = await root.call(yieldSource, 'storage_balance_of', { account_id: contract })
  console.log('balanceOf: ', balanceOf)
  const session = await contract.view('getSession', { sessionId: currentSessionId })

  const player1 = await contract.view('getPlayer', {
    sessionId: currentSessionId,
    address: vzg.accountId,
  })

  const player2 = await contract.view('getPlayer', {
    sessionId: currentSessionId,
    address: alice.accountId,
  })

  const player3 = await contract.view('getPlayer', {
    sessionId: currentSessionId,
    address: bob.accountId,
  })

  const sessionEnd = BigInt(session.end)

  const bigIntDeposit1 = deposit1.toBigInt()
  const bigIntDeposit2 = deposit2.toBigInt()
  const bigIntDeposit3 = deposit3.toBigInt()

  const remainingTime1 = sessionEnd - stakeTransactionTime1
  const simulatedPlayerTickets1 = remainingTime1 * bigIntDeposit1

  const remainingTime2 = sessionEnd - stakeTransactionTime2
  const simulatedPlayerTickets2 = remainingTime2 * bigIntDeposit2

  const remainingTime3 = sessionEnd - stakeTransactionTime3
  const simulatedPlayerTickets3 = remainingTime3 * bigIntDeposit3

  const totalSimulatedTickets =
    simulatedPlayerTickets1 + simulatedPlayerTickets2 + simulatedPlayerTickets3

  t.is(BigInt(player1.amount), bigIntDeposit1)
  t.is(BigInt(player1.tickets), simulatedPlayerTickets1)

  t.is(BigInt(player2.amount), bigIntDeposit2)
  t.is(BigInt(player2.tickets), simulatedPlayerTickets2)

  t.is(BigInt(player3.amount), bigIntDeposit3)
  t.is(BigInt(player3.tickets), simulatedPlayerTickets3)

  t.is(BigInt(session.totalTickets), totalSimulatedTickets)

  return { root, contract, currentSessionId, vzg, alice, bob }
}
