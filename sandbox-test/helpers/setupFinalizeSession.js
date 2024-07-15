import setupStakes from './setupStakes.js'

export default async function setupFinalizeSession(t) {
  try {
    const { root, contract, currentSessionId, vzg, alice, bob } = await setupStakes(t)
    const sessionBeforeFinalize = await contract.view('getSession', { sessionId: currentSessionId })
    const players = sessionBeforeFinalize.players

    await t.context.worker.provider.fastForward(100)
    const forward_height = (sessionBeforeFinalize.duration / 3000000000).toFixed()

    await t.context.worker.provider.fastForward(Number(forward_height))

    // Wait until the session ends (simulate passing time)

    const tx = await root.call(contract, 'finalizeSession', {})

    const sessionAfterFinalize = await contract.view('getSession', { sessionId: currentSessionId })
    // Check the session state after finalization
    t.truthy(sessionAfterFinalize.winingNumbers.length > 0, 'Wining numbers should be generated')

    return { t, root, contract, currentSessionId, vzg, alice, bob }
  } catch (err) {
    console.log(err.message)
  }
}
