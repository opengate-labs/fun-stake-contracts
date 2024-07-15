// Find all our documentation at https://docs.near.org
import {
  assert,
  NearBindgen,
  NearPromise,
  ONE_YOCTO,
  UnorderedMap,
  call,
  initialize,
  near,
  view,
} from 'near-sdk-js'

type Player = {
  tickets: string
  amount: string
  isClaimed: boolean
}

type Session = {
  id: string
  reward: string
  amount: string
  totalTickets: string
  players: UnorderedMap<Player>
  duration: string
  start: string
  end: string
  countOfWinNumbers: number
  winingNumbers: string[]
  isFinalized: boolean //1. winning numbers OK 2. Reward set for claim
}

const THIRTY_TGAS = BigInt('30000000000000')
const FIFTY_TGAS = BigInt('50000000000000')
const CALL_TGAS: bigint = BigInt('10000000000000')
const NO_DEPOSIT = BigInt(0)
const NO_ARGS = JSON.stringify({})

@NearBindgen({})
class FunStake {
  currentSessionId = ''
  sessions = new UnorderedMap<Session>('sessions')
  day = 86400
  admin = ''
  yieldSource = ''
  refFinance = ''
  fee = BigInt(0)
  contractReward = BigInt(0)

  @initialize({})
  init({ yieldSource, admin }: { yieldSource: string; admin: string }): void {
    this.admin = admin
    this.yieldSource = yieldSource
  }

  @call({})
  set_fee({ fee }: { fee: bigint }): void {
    assert(near.predecessorAccountId() === this.admin, 'Only the admin can change the fee')
    this.fee = BigInt(fee)
  }

  @call({})
  set_admin({ address }: { address: string }): void {
    this.admin = address
  }

  @view({})
  get_contract_reward(): string {
    return this.contractReward.toString()
  }

  @view({})
  get_fee(): string {
    return this.fee.toString()
  }

  @view({})
  get_session({ sessionId = this.currentSessionId }: { sessionId: string }): Session {
    const session = this.sessions.get(sessionId)
    assert(session, 'Session not found')

    return session
  }

  @view({})
  get_admin(): string {
    return this.admin
  }

  @view({})
  get_yield_source(): string {
    return this.yieldSource
  }

  @view({})
  get_current_session_id() {
    return this.currentSessionId
  }

  @call({ payableFunction: true })
  stake(): NearPromise {
    const currentSessionId = this.currentSessionId
    const session = this.sessions.get(currentSessionId)
    const now = near.blockTimestamp().toString()

    assert(session, 'Session not found')
    assert(now < session.end, 'Session is ended')

    const sender = near.predecessorAccountId()
    const deposit = near.attachedDeposit()

    near.log('BEFORE Yield DEPOSIT')

    return NearPromise.new(this.yieldSource)
      .functionCall('deposit', NO_ARGS, deposit, CALL_TGAS)
      .then(
        NearPromise.new(near.currentAccountId()).functionCall(
          'finalize_stake',
          JSON.stringify({ sessionId: currentSessionId, playerAddress: sender, now }),
          deposit,
          THIRTY_TGAS,
        ),
      )
  }

  @call({ privateFunction: true, payableFunction: true })
  finalize_stake({
    sessionId,
    playerAddress,
    now,
  }: { sessionId: string; playerAddress: string; now: string }): void {
    near.log('---- IN FINALIZE STAKE ----')

    assert(
      near.predecessorAccountId() === near.currentAccountId(),
      'Only contract can call this method',
    )

    const { result, success } = promiseResult(0)

    near.log('---- FINALIZE STAKE PROMISE RESULT ----', result, success)

    if (!success) {
      near.log('finalize_stake failed', result)

      NearPromise.new(playerAddress).transfer(near.attachedDeposit())
      return
    }

    // TODO: revert correctly the state OR maybe even set it here when promises went ok
    near.log('finalize_stake success', result)

    const deposit = near.attachedDeposit()
    const session = this.sessions.get(sessionId)
    const players = UnorderedMap.reconstruct(session.players)
    const player = players.get(playerAddress)

    // const pastTime = near.blockTimestamp() - session.start
    // Do we need to caluclate based on day or just seconds
    const remainingTime = BigInt(session.end) - BigInt(now)
    // const remainingDays = session.duration / this.day - pastTime / this.day
    const newUserTickets = remainingTime * deposit
    const newTotalUserTickets = BigInt(player ? player.tickets : 0) + newUserTickets

    const finalAmount = BigInt(player ? player.amount : 0) + deposit

    players.set(playerAddress, {
      amount: String(finalAmount),
      tickets: String(newTotalUserTickets),
      isClaimed: false,
    })

    const sessionTotalTickets = BigInt(session.totalTickets) + newUserTickets
    const sessionAmount = BigInt(session.amount) + deposit

    this.sessions.set(sessionId, {
      ...session,
      players,
      totalTickets: String(sessionTotalTickets),
      amount: String(sessionAmount),
    })
  }

  @call({})
  start_session({
    duration,
    countOfWinNumbers,
  }: { duration: bigint; countOfWinNumbers: number }): void {
    assert(near.predecessorAccountId() === this.admin, 'Only admin can call this method')

    const newSessionId = String(this.sessions.length)
    const now = near.blockTimestamp().toString()
    const end = BigInt(now) + BigInt(duration)

    // TODO: move common parts outside contract
    const session: Session = {
      id: newSessionId,
      amount: '0',
      reward: '0',
      players: new UnorderedMap<Player>(`session_${newSessionId}_players`),
      duration: duration.toString(),
      start: now,
      end: end.toString(),
      totalTickets: '0',
      countOfWinNumbers,
      winingNumbers: [],
      isFinalized: false,
    }

    this.sessions.set(newSessionId, session)
    this.currentSessionId = newSessionId
  }

  @call({ payableFunction: true })
  finalize_session({ sessionId = this.currentSessionId }: { sessionId: string }): NearPromise {
    const session = this.sessions.get(sessionId)

    assert(session, 'Session not found')
    assert(!session.isFinalized, 'Session is finalized')
    assert(near.blockTimestamp().toString() > session.end, 'Session is not ended yet')

    const promise = NearPromise.new(this.yieldSource)
      // .functionCall('receive_dividends', NO_ARGS, near.attachedDeposit(), CALL_TGAS)
      .functionCall(
        'storage_balance_of',
        JSON.stringify({ account_id: near.currentAccountId() }),
        NO_DEPOSIT,
        THIRTY_TGAS,
      )
      .then(
        NearPromise.new(near.currentAccountId()).functionCall(
          'finalize_session_callback',
          JSON.stringify({ sessionId }),
          near.attachedDeposit(),
          FIFTY_TGAS,
        ),
      )

    return promise.asReturn()
  }

  @call({ privateFunction: true, payableFunction: true })
  finalize_session_callback({ sessionId }: { sessionId: string }) {
    const session = this.sessions.get(sessionId || this.currentSessionId)

    // TODO: revert state if failed promise ? or move logics here?
    const { result, success } = promiseResult(0)

    const balanceOf = JSON.parse(result)

    if (!success) {
      near.log('finalizeSessionCallback failed', balanceOf)
      return
    }

    near.log('finalizeSessionCallback Success results balanceOf : ', balanceOf)

    const winingNumbers = []
    for (let i = 0; i < session.countOfWinNumbers; i++) {
      const randomSeed = near.randomSeed()
      const randomNumber = new Uint8Array(randomSeed)

      let value = BigInt(0)
      for (let j = 0; j < randomNumber.length; j++) {
        value = value * BigInt(256) + BigInt(randomNumber[j])
      }

      const sessionTotalTickets =
        BigInt(session.totalTickets) > BigInt(0) ? BigInt(session.totalTickets) : BigInt(1)

      near.log('Value: ', value)
      near.log('session.totalTickets: ', sessionTotalTickets)

      const winningNumber = value % sessionTotalTickets
      near.log('winningNumber: ', winningNumber)
      winingNumbers.push(winningNumber)
    }
    // TODO:
    // 1. Unstake funds in this function
    // 2. Identify reward amount and set somewhere

    const accumulatedReward = BigInt(balanceOf) - BigInt(session.amount)
    near.log('accumulatedReward', accumulatedReward)
    const protocolFee = (accumulatedReward * this.fee) / BigInt(100)
    near.log('protocolFee', protocolFee)
    const pureReward = accumulatedReward - protocolFee
    near.log('pureReward', pureReward)

    this.contractReward += protocolFee
    this.sessions.set(sessionId, {
      ...session,
      winingNumbers,
      reward: pureReward.toString(),
      isFinalized: true,
    })

    const args = JSON.stringify({
      amount: balanceOf,
    })

    near.log('FUCKED UP HERE 2')
    // TOODO: keep in mind that witdhraw can go wrong
    return NearPromise.new(this.yieldSource).functionCall(
      'withdraw',
      args,
      near.attachedDeposit(),
      THIRTY_TGAS,
    )
    // .then(NearPromise.new(near.currentAccountId()).functionCall('distributeRewards'))

    // TODO: linear/refFinance implementation
    // const args = JSON.stringify({
    //   actions: [
    //     {
    //       pool_id: 3088,
    //       token_in: 'near.testnet',
    //       amount_in,
    //       // amount_in: session.amount,
    //       token_out: this.yieldSource,
    //       min_amount_out: 1,
    //     },
    //   ],
    // })

    // return NearPromise.new(this.refFinance).functionCall('swap', args, NO_DEPOSIT, THIRTY_TGAS)
  }

  // TODO: do we need this?
  // @call({ privateFunction: true })
  // distributeRewards({ accumulatedReward }: { accumulatedReward: string }): void {
  //   accumulatedReward
  // }

  @call({})
  claim({ sessionId = this.currentSessionId }: { sessionId: string }): NearPromise {
    const session = this.sessions.get(sessionId)
    const players = UnorderedMap.reconstruct(session.players)

    assert(session, 'Session not found')
    assert(near.blockTimestamp().toString() > session.end, 'Session is not ended yet')
    assert(session.isFinalized, 'Session is not finalized yet')

    const sender = near.predecessorAccountId()
    const player = players.get(sender)

    assert(player, 'Player not found')
    assert(BigInt(player.tickets) > 0, 'Player has no tickets')
    assert(BigInt(player.amount) > 0, 'Player has no deposit')
    assert(!player.isClaimed, 'Player already claimed')

    const ticketRange = this.get_player_tickets_range({ address: sender, sessionId })

    let isWinner: boolean
    let finalReward: bigint
    for (const randomNumber of session.winingNumbers) {
      near.log('--- ticketRange[0] ----', ticketRange[0])
      near.log('--- randomNumber ----', randomNumber)
      near.log('--- ticketRange[1] ----', ticketRange[1])
      if (BigInt(randomNumber) >= ticketRange[0] && BigInt(randomNumber) < ticketRange[1]) {
        finalReward = BigInt(player.amount) + BigInt(session.reward)
        isWinner = true

        near.log(`Player ${sender} won ${finalReward} NEAR`)
      }
    }

    players.set(sender, { ...player, isClaimed: true })

    return isWinner
      ? NearPromise.new(sender).transfer(finalReward)
      : NearPromise.new(sender).transfer(BigInt(player.amount))
  }

  @view({})
  get_player_tickets_range({
    address,
    sessionId = this.currentSessionId,
  }: { address: string; sessionId: string }): bigint[] {
    const session = this.sessions.get(sessionId)
    const players = UnorderedMap.reconstruct(session.players)
    const ticketRange: bigint[] = [BigInt(0), BigInt(0)]
    let cumulativeTickets = BigInt(0)

    for (const [key, player] of players.toArray()) {
      if (key === address) {
        ticketRange[0] = cumulativeTickets
        ticketRange[1] = cumulativeTickets + BigInt(player.tickets)
        break
      }

      cumulativeTickets += BigInt(player.tickets)
    }

    return ticketRange
  }

  @view({})
  get_player({ sessionId, address }: { sessionId: string; address: string }): Player {
    const session = this.sessions.get(sessionId)
    const players = UnorderedMap.reconstruct(session.players)

    return players.get(address)
  }
}

export function promiseResult(index: number): { result: string; success: boolean } {
  let result: string | undefined
  let success: boolean

  try {
    ;(result as string) = near.promiseResult(index)
    success = true
  } catch (err) {
    near.log(JSON.stringify(err))
    result = undefined
    success = false
  }

  return {
    result,
    success,
  }
}
