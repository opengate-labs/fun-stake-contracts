// Find all our documentation at https://docs.near.org
import {
  assert,
  NearBindgen,
  NearPromise,
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
  sessions = new UnorderedMap<Session>('ss')
  day = 86400
  admin = ''
  yieldSource = ''
  refFinance = ''
  fee = BigInt(0)
  contractReward = BigInt(0)
  stakeStorageCost = BigInt(2500000000000000000000)

  @initialize({})
  init({ yieldSource, admin }: { yieldSource: string; admin: string }): void {
    this.admin = admin
    this.yieldSource = yieldSource
  }

  @call({})
  set_stake_storage_cost({ amount }: { amount: bigint }): void {
    assert(
      near.predecessorAccountId() === this.admin,
      'Only the admin can change the stake storage cost',
    )
    this.stakeStorageCost = BigInt(amount)
  }

  @call({})
  set_fee({ fee }: { fee: bigint }): void {
    assert(near.predecessorAccountId() === this.admin, 'Only the admin can change the fee')
    this.fee = BigInt(fee)
  }

  @call({})
  set_admin({ address }: { address: string }): void {
    assert(near.predecessorAccountId() === this.admin, 'Only the admin can change the admin')

    this.admin = address
  }

  @call({})
  withdrawContractReward(): void {
    assert(
      near.predecessorAccountId() === this.admin,
      'Only the admin can withdraw the contract reward',
    )
    assert(this.contractReward > BigInt(0), 'Contract reward is empty')

    NearPromise.new(this.admin).transfer(this.contractReward)
  }

  @view({})
  get_contract_reward(): string {
    return this.contractReward.toString()
  }

  @view({})
  get_stake_storage_cost(): string {
    return this.stakeStorageCost.toString()
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
  cashout({ sessionId = this.currentSessionId }: { sessionId: string }): NearPromise {
    const sender = near.predecessorAccountId()
    const session = this.sessions.get(sessionId)
    const players = UnorderedMap.reconstruct(session.players)
    const player = players.get(sender)

    assert(player, 'Player not found')
    assert(near.blockTimestamp().toString() < session.end, 'Session is ended')

    return NearPromise.new(this.yieldSource)
      .functionCall(
        'withdraw',
        JSON.stringify({
          amount: player.amount,
        }),
        near.attachedDeposit(),
        THIRTY_TGAS,
      )
      .then(
        NearPromise.new(near.currentAccountId()).functionCall(
          'cashout_callback',
          JSON.stringify({ address: sender, sessionId }),
          NO_DEPOSIT,
          THIRTY_TGAS,
        ),
      )
  }

  @call({ privateFunction: true })
  cashout_callback({ sessionId, address }: { sessionId: string; address: string }): NearPromise {
    assert(
      near.predecessorAccountId() === near.currentAccountId(),
      'Only contract can call this method',
    )

    const { result, success } = promiseResult(0)

    if (!success) {
      near.log('cashout failed', result)
      return
    }

    const session = this.sessions.get(sessionId)
    const players = UnorderedMap.reconstruct(session.players)
    const player = players.get(address)

    assert(player, 'Player not found')
    assert(near.blockTimestamp().toString() < session.end, 'Session is ended')

    const playerAmount = BigInt(player.amount)
    const playerTickets = BigInt(player.tickets)
    const newSessionTotalTickets = BigInt(session.totalTickets) - playerTickets
    const newSessionAmount = BigInt(session.amount) - playerAmount

    players.remove(address)

    this.sessions.set(sessionId, {
      ...session,
      players,
      totalTickets: newSessionTotalTickets.toString(),
      amount: newSessionAmount.toString(),
    })

    return NearPromise.new(address).transfer(playerAmount + this.stakeStorageCost)
  }

  @call({ payableFunction: true })
  stake(): NearPromise {
    const initialStorageUsage = near.storageUsage()
    near.log('initialStorageUsage: ', initialStorageUsage)

    const currentSessionId = this.currentSessionId
    const session = this.sessions.get(currentSessionId)
    const now = near.blockTimestamp().toString()

    assert(session, 'Session not found')
    assert(now < session.end, 'Session is ended')

    const sender = near.predecessorAccountId()
    const players = UnorderedMap.reconstruct(session.players)
    const player = players.get(sender)
    const deposit = player ? near.attachedDeposit() : near.attachedDeposit() - this.stakeStorageCost

    assert(deposit > 0, 'Deposit must be greater than 0')

    return NearPromise.new(this.yieldSource)
      .functionCall('deposit', NO_ARGS, deposit, CALL_TGAS)
      .then(
        NearPromise.new(near.currentAccountId()).functionCall(
          'finalize_stake',
          JSON.stringify({
            sessionId: currentSessionId,
            playerAddress: sender,
            now,
            amount: deposit.toString(),
            initialStorageUsage: initialStorageUsage.toString(),
          }),
          NO_DEPOSIT,
          THIRTY_TGAS,
        ),
      )
  }

  @call({ privateFunction: true })
  finalize_stake({
    sessionId,
    playerAddress,
    now,
    initialStorageUsage,
    amount,
  }: {
    sessionId: string
    playerAddress: string
    now: string
    amount: string
    initialStorageUsage: string
  }): void {
    assert(
      near.predecessorAccountId() === near.currentAccountId(),
      'Only contract can call this method',
    )

    const { result, success } = promiseResult(0)

    if (!success) {
      near.log('finalize_stake failed', result)

      NearPromise.new(playerAddress).transfer(BigInt(amount))
      return
    }

    near.storageUsage()

    const userDeposit = BigInt(amount)
    const session = this.sessions.get(sessionId)
    const players = UnorderedMap.reconstruct(session.players)
    const player = players.get(playerAddress)

    // const pastTime = near.blockTimestamp() - session.start
    // Do we need to caluclate based on day or just seconds
    const remainingTime = BigInt(session.end) - BigInt(now)
    // const remainingDays = session.duration / this.day - pastTime / this.day
    const newUserTickets = remainingTime * userDeposit
    const newTotalUserTickets = BigInt(player ? player.tickets : 0) + newUserTickets

    const finalAmount = BigInt(player ? player.amount : 0) + userDeposit

    players.set(playerAddress, {
      amount: String(finalAmount),
      tickets: String(newTotalUserTickets),
      isClaimed: false,
    })

    const sessionTotalTickets = BigInt(session.totalTickets) + newUserTickets
    const sessionAmount = BigInt(session.amount) + userDeposit

    this.sessions.set(sessionId, {
      ...session,
      players,
      totalTickets: String(sessionTotalTickets),
      amount: String(sessionAmount),
    })

    const finalStorageUsage = near.storageUsage()
    near.log('finalStorageUsage: ', finalStorageUsage)

    const storageToDeduct = finalStorageUsage - BigInt(initialStorageUsage)
    near.log('storageToDeduct: ', storageToDeduct)
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

    const session: Session = {
      id: newSessionId,
      amount: '0',
      reward: '0',
      players: new UnorderedMap<Player>(`s_${newSessionId}_p`),
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
      .functionCall('receive_dividends', NO_ARGS, near.attachedDeposit(), CALL_TGAS)
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

    const { result, success } = promiseResult(0)

    const balanceOf = JSON.parse(result)

    if (!success) {
      near.log('finalizeSessionCallback failed', balanceOf)
      return
    }

    near.log('finalizeSessionCallback balanceOf in yieldSource: ', balanceOf)

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

      const winningNumber = value % sessionTotalTickets

      winingNumbers.push(winningNumber)
    }

    const accumulatedReward = BigInt(balanceOf) - BigInt(session.amount)
    const protocolFee = (accumulatedReward * this.fee) / BigInt(100)
    const pureReward = accumulatedReward - protocolFee

    near.log('accumulatedReward', accumulatedReward)
    near.log('protocolFee', protocolFee)
    near.log('pureReward', pureReward)

    this.contractReward += protocolFee
    this.sessions.set(sessionId, {
      ...session,
      winingNumbers,
      reward: pureReward.toString(),
      isFinalized: true,
    })

    return NearPromise.new(this.yieldSource).functionCall(
      'withdraw',
      JSON.stringify({
        amount: balanceOf,
      }),
      near.attachedDeposit(),
      THIRTY_TGAS,
    )
  }

  @call({})
  claim({ sessionId = this.currentSessionId }: { sessionId: string }): NearPromise {
    const session = this.sessions.get(sessionId)

    assert(session, 'Session not found')
    assert(near.blockTimestamp().toString() > session.end, 'Session is not ended yet')
    assert(session.isFinalized, 'Session is not finalized yet')

    const sender = near.predecessorAccountId()
    const players = UnorderedMap.reconstruct(session.players)
    const player = players.get(sender)

    assert(player, 'Player not found')
    assert(BigInt(player.tickets) > 0, 'Player has no tickets')
    assert(BigInt(player.amount) > 0, 'Player has no deposit')
    assert(!player.isClaimed, 'Player already claimed')

    const ticketRange = this.get_player_tickets_range({ address: sender, sessionId })

    let isWinner: boolean
    let finalReward: bigint
    for (const randomNumber of session.winingNumbers) {
      if (BigInt(randomNumber) >= ticketRange[0] && BigInt(randomNumber) < ticketRange[1]) {
        finalReward = BigInt(player.amount) + BigInt(session.reward)
        isWinner = true
      }
    }

    players.set(sender, { ...player, isClaimed: true })

    return isWinner
      ? NearPromise.new(sender).transfer(finalReward)
      : NearPromise.new(sender).transfer(BigInt(player.amount))
  }

  @view({})
  get_player_chance({
    address,
    sessionId = this.currentSessionId,
  }: { address: string; sessionId: string }): string {
    const session = this.sessions.get(sessionId)
    const players = UnorderedMap.reconstruct(session.players)
    const player = players.get(address)

    if (!players.get(address)) {
      return '0'
    }

    const totalTickets = Number(session.totalTickets)
    const playerTickets = Number(player.tickets)

    const chance = (playerTickets / totalTickets) * 100

    return chance.toString()
  }

  @view({})
  get_session_winners({ sessionId = this.currentSessionId }: { sessionId: string }): string[] {
    const session = this.sessions.get(sessionId)
    const players = UnorderedMap.reconstruct(session.players)
    const winningNumber = BigInt(session.winingNumbers[0])
    const winners: string[] = []

    for (const [address] of players.toArray()) {
      const ticketsRange = this.get_player_tickets_range({ address, sessionId })

      if (winningNumber >= ticketsRange[0] && winningNumber <= ticketsRange[1]) {
        winners.push(address)
      }
    }

    return winners
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
