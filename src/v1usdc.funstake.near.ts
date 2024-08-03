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
  ONE_YOCTO,
  LookupSet,
  LookupMap,
} from 'near-sdk-js'

// @ts-expect-error
BigInt.prototype.toJSON = function () {
  return this.toString()
}

type Player = {
  tickets: bigint
  amount: bigint
  isClaimed: boolean
}

type Session = {
  id: string
  storageDeposits: LookupMap<boolean>
  reward: bigint
  amount: bigint
  totalTickets: bigint
  players: UnorderedMap<Player>
  duration: bigint
  start: bigint
  end: bigint
  countOfWinNumbers: number
  winingNumbers: bigint[]
  isFinalized: boolean //1. winning numbers OK 2. Reward set for claim
  // storageDeposits:
}

const THIRTY_TGAS = BigInt('30000000000000')
const HUNDRED_TGAS = BigInt('100000000000000')
const FIFTY_TGAS = BigInt('50000000000000')
const CALL_TGAS = BigInt('10000000000000')
const NO_DEPOSIT = BigInt(0)
const NO_ARGS = JSON.stringify({})

@NearBindgen({})
class FunStakeUsdc {
  currentSessionId = ''
  sessions = new UnorderedMap<Session>('ss')
  admin = ''
  yieldSource = ''
  token = ''
  fee = BigInt(0)
  contractReward = BigInt(0)
  stakeStorageCost = BigInt(2500000000000000000000)

  @initialize({})
  init({ yieldSource, admin, token }: { yieldSource: string; admin: string; token: string }): void {
    this.admin = admin
    this.yieldSource = yieldSource
    this.token = token
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
    assert(BigInt(this.contractReward) > BigInt(0), 'Contract reward is empty')

    NearPromise.new(this.admin).transfer(BigInt(this.contractReward))
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
  get_token(): string {
    return this.token
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
    const expectedMinimumGas = HUNDRED_TGAS + FIFTY_TGAS + THIRTY_TGAS + THIRTY_TGAS

    assert(player, 'Player not found')
    assert(near.blockTimestamp() < BigInt(session.end), 'Session is ended')
    assert(
      near.prepaidGas() >= expectedMinimumGas,
      `Not enough prepaid gas, minimum ${expectedMinimumGas} required`,
    )

    const playerAmount = BigInt(player.amount) * BigInt(10 ** 12)
    const args = JSON.stringify({
      actions: [
        {
          Withdraw: {
            token_id: this.token,
            max_amount: playerAmount.toString(),
          },
        },
      ],
    })

    return NearPromise.new(this.yieldSource)
      .functionCall('execute', args, near.attachedDeposit(), HUNDRED_TGAS)
      .then(
        NearPromise.new(this.token).functionCall(
          'ft_transfer',
          JSON.stringify({
            receiver_id: sender,
            amount: BigInt(player.amount),
            msg: '',
          }),
          ONE_YOCTO,
          FIFTY_TGAS,
        ),
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
    const playerAmount = BigInt(player.amount)
    const newSessionTotalTickets = BigInt(session.totalTickets) - BigInt(player.tickets)
    const newSessionAmount = BigInt(session.amount) - playerAmount
    const storageDeposits = LookupMap.reconstruct<boolean>(session.storageDeposits)
    const playerStorageDeposit = storageDeposits.get(`${this.currentSessionId}:${address}`)

    storageDeposits.remove(`${sessionId}:${address}`)
    players.remove(address)

    this.sessions.set(sessionId, {
      ...session,
      players,
      totalTickets: newSessionTotalTickets,
      amount: newSessionAmount,
      storageDeposits,
    })

    // TODO: consider returning stake for storage in future
    if (playerStorageDeposit) {
      return NearPromise.new(address).transfer(BigInt(this.stakeStorageCost))
    }
  }

  @call({ payableFunction: true })
  storage_deposit(): void {
    assert(near.attachedDeposit() === BigInt(this.stakeStorageCost), 'Not enough attached deposit')

    const session = this.sessions.get(this.currentSessionId)

    assert(session, 'Session not found')
    assert(near.blockTimestamp() < BigInt(session.end), 'Session is ended')

    const storageDeposits = LookupMap.reconstruct<boolean>(session.storageDeposits)

    assert(
      !storageDeposits.get(`${this.currentSessionId}:${near.predecessorAccountId()}`),
      `Already deposited for ${this.currentSessionId}`,
    )

    storageDeposits.set(`${this.currentSessionId}:${near.predecessorAccountId()}`, true)

    this.sessions.set(this.currentSessionId, { ...session, storageDeposits })
  }

  @call({})
  ft_on_transfer({
    sender_id,
    amount,
    msg,
  }: {
    sender_id: string
    amount: string
    msg: string
  }): NearPromise | string {
    try {
      const now = near.blockTimestamp()
      const session = this.sessions.get(this.currentSessionId)
      const expectedMinimumGas = FIFTY_TGAS + FIFTY_TGAS + THIRTY_TGAS
      const storageDeposits = LookupMap.reconstruct<boolean>(session.storageDeposits)
      const playerStorageDeposit = storageDeposits.get(`${this.currentSessionId}:${sender_id}`)

      assert(playerStorageDeposit, 'Storage deposit not found')
      assert(near.predecessorAccountId() === this.token, 'Only the token can call this method')
      assert(
        near.prepaidGas() >= expectedMinimumGas,
        `Not enough prepaid gas, minimum ${expectedMinimumGas} required`,
      )
      assert(session, "Session doesn't exist")
      assert(now < BigInt(session.end), 'Session ended')

      const initialStorageUsage = near.storageUsage()
      near.log('initialStorageUsage: ', initialStorageUsage)

      // const session = this.sessions.get(this.currentSessionId)

      // if (near.attachedDeposit() >= storageCost) {
      const args = JSON.stringify({
        receiver_id: this.yieldSource,
        amount,
        msg,
      })

      const promise = NearPromise.new(this.token)
        .functionCall('ft_transfer_call', args, ONE_YOCTO, FIFTY_TGAS)
        .then(
          NearPromise.new(near.currentAccountId()).functionCall(
            'finalize_stake',
            JSON.stringify({
              sender_id,
              amount,
              now,
              initialStorageUsage,
            }),
            NO_DEPOSIT,
            FIFTY_TGAS,
          ),
        )

      return promise.asReturn()
    } catch (e) {
      near.log('error: ', e)

      return amount
    }
  }

  @call({ privateFunction: true })
  finalize_stake({ sender_id, amount, now, initialStorageUsage }) {
    try {
      const { result, success } = promiseResult(0)

      near.log('IN finalize_stake', result, success)

      if (!success) {
        near.log('finalize_stake failed', result)

        return amount
      }

      assert(
        near.predecessorAccountId() === near.currentAccountId(),
        'Only contract can call this method',
      )

      const session = this.sessions.get(this.currentSessionId)
      const sessionEnd = BigInt(session.end)
      const safeNow = BigInt(now)

      assert(session, 'Session not found')
      assert(safeNow < sessionEnd, 'Session is ended')

      const players = UnorderedMap.reconstruct(session.players)
      const player = players.get(sender_id)
      near.log('Player before stake: ', player)

      const userDeposit = BigInt(amount)
      const remainingTime = BigInt(session.end) - BigInt(now)
      const newUserTickets = remainingTime * userDeposit
      const newTotalUserTickets = (player ? BigInt(player.tickets) : BigInt(0)) + newUserTickets

      const finalAmount = (player ? BigInt(player.amount) : BigInt(0)) + userDeposit
      const newSessionTotalTickets = BigInt(session.totalTickets) + newUserTickets
      const newSessionAmount = BigInt(session.amount) + userDeposit

      near.log('remainingTime: ', typeof remainingTime, remainingTime)
      near.log('userDeposit: ', typeof userDeposit, userDeposit)
      near.log('session.end: ', typeof session.end, session.end)
      near.log('newUserTickets: ', typeof newUserTickets, newUserTickets)
      near.log('newTotalUserTickets: ', typeof newTotalUserTickets, newTotalUserTickets)
      near.log('player.amount: ', typeof player?.amount, player?.amount)
      near.log('finalAmount: ', typeof finalAmount, finalAmount)
      near.log('session.totalTickets: ', typeof session.totalTickets, session.totalTickets)

      players.set(sender_id, {
        amount: BigInt(finalAmount),
        tickets: BigInt(newTotalUserTickets),
        isClaimed: false,
      })

      near.log('new players: ', players)
      near.log('new player: ', players.get(sender_id))

      this.sessions.set(this.currentSessionId, {
        ...session,
        players,
        totalTickets: BigInt(newSessionTotalTickets),
        amount: BigInt(newSessionAmount),
      })

      near.log('new session : ', this.sessions.get(this.currentSessionId))

      const finalStorageUsage = near.storageUsage()
      near.log('finalStorageUsage: ', typeof finalStorageUsage, finalStorageUsage)
      near.log('initialStorage: ', typeof initialStorageUsage, initialStorageUsage)
      near.log('storage to deduct : ', finalStorageUsage - BigInt(initialStorageUsage))

      return '0'
    } catch (e) {
      near.log('catch finalize_stake failed', e)

      return amount
    }
  }

  @call({})
  start_session({
    duration,
    countOfWinNumbers,
  }: {
    duration: string
    countOfWinNumbers: number
  }): void {
    assert(near.predecessorAccountId() === this.admin, 'Only admin can call this method')

    const safeDuration = BigInt(duration)
    const newSessionId = String(this.sessions.length)
    const now = near.blockTimestamp()
    const end = now + safeDuration

    const session: Session = {
      id: newSessionId,
      amount: BigInt(0),
      reward: BigInt(0),
      players: new UnorderedMap<Player>(`s_${newSessionId}_p`),
      duration: safeDuration,
      start: now,
      end: end,
      totalTickets: BigInt(0),
      countOfWinNumbers,
      winingNumbers: [],
      isFinalized: false,
      storageDeposits: new LookupMap<boolean>(`s_${newSessionId}_sd`),
    }

    this.sessions.set(newSessionId, session)
    this.currentSessionId = newSessionId
  }

  @call({ payableFunction: true })
  finalize_session({ sessionId = this.currentSessionId }: { sessionId: string }): NearPromise {
    const session = this.sessions.get(sessionId)

    const expectedMinimumGas = THIRTY_TGAS + HUNDRED_TGAS + FIFTY_TGAS + THIRTY_TGAS

    assert(session, 'Session not found')
    assert(!session.isFinalized, 'Session is finalized')
    assert(
      near.prepaidGas() >= expectedMinimumGas,
      `Not enough prepaid gas, minimum ${expectedMinimumGas} required`,
    )
    assert(near.blockTimestamp() > BigInt(session.end), 'Session is not ended yet')

    const promise = NearPromise.new(this.yieldSource)
      .functionCall(
        'get_account',
        JSON.stringify({ account_id: near.currentAccountId() }),
        NO_DEPOSIT,
        THIRTY_TGAS,
      )
      .and(
        NearPromise.new(this.yieldSource).functionCall(
          'execute',
          JSON.stringify({
            actions: [
              {
                Withdraw: {
                  token_id: this.token,
                },
              },
            ],
          }),
          near.attachedDeposit(),
          HUNDRED_TGAS,
        ),
      )
      .then(
        NearPromise.new(near.currentAccountId()).functionCall(
          'finalize_session_callback',
          JSON.stringify({ sessionId }),
          NO_DEPOSIT,
          FIFTY_TGAS,
        ),
      )

    return promise.asReturn()
  }

  @call({ privateFunction: true, payableFunction: true })
  finalize_session_callback({ sessionId }: { sessionId: string }) {
    const session = this.sessions.get(sessionId || this.currentSessionId)

    const { result, success } = promiseResult(0)

    if (!success) {
      near.log('finalizeSessionCallback failed')
      return
    }

    const userData = JSON.parse(result)
    const suppliedTokens = userData.supplied
    const suppliedUsdc = suppliedTokens?.find((token) => token.token_id === this.token)
    const suppliedUsdcBalance = suppliedUsdc ? BigInt(suppliedUsdc.balance) : BigInt(0)

    near.log('suppliedTokens: ', suppliedTokens)
    near.log('suppliedUsdcBalance: ', suppliedUsdcBalance)

    near.log(
      'finalizeSessionCallback suppliedUsdcBalance in yieldSource: ',
      typeof suppliedUsdcBalance,
      suppliedUsdcBalance,
    )

    const winingNumbers = []
    for (let i = 0; i < session.countOfWinNumbers; i++) {
      const randomSeed = near.randomSeed()
      const randomNumber = new Uint8Array(randomSeed)

      let value = BigInt(0)
      for (let j = 0; j < randomNumber.length; j++) {
        value = value * BigInt(256) + BigInt(randomNumber[j])
      }

      const sessionTotalTickets =
        session.totalTickets > BigInt(0) ? session.totalTickets : BigInt(1)

      const winningNumber = BigInt(value) % BigInt(sessionTotalTickets)

      winingNumbers.push(winningNumber)
    }

    // TODO: make extra decimal dynamic
    // TODO: keep in mind that 12 can be different for other tokens in Burrow
    // 5000000n - 2000000n = 3000000n
    const accumulatedReward = suppliedUsdcBalance / BigInt(10 ** 12) - BigInt(session.amount)
    near.log('accumulatedReward', accumulatedReward)

    const protocolFee = (BigInt(accumulatedReward) * BigInt(this.fee)) / BigInt(100)
    near.log('protocolFee', protocolFee)

    const pureReward = accumulatedReward - protocolFee
    near.log('pureReward', pureReward)

    this.contractReward = BigInt(this.contractReward) + BigInt(protocolFee)
    this.sessions.set(sessionId, {
      ...session,
      winingNumbers,
      reward: pureReward,
      isFinalized: true,
    })
  }

  @call({})
  claim({ sessionId = this.currentSessionId }: { sessionId: string }): NearPromise {
    const session = this.sessions.get(sessionId)
    const expectedMinimumGas = FIFTY_TGAS + THIRTY_TGAS + THIRTY_TGAS

    assert(
      near.prepaidGas() >= expectedMinimumGas,
      `Not enough prepaid gas, minimum ${expectedMinimumGas} required`,
    )
    assert(session, 'Session not found')
    assert(near.blockTimestamp() > BigInt(session.end), 'Session is not ended yet')
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

    const amountToClaim = isWinner ? finalReward : player.amount

    return NearPromise.new(this.token)
      .functionCall(
        'ft_transfer',
        JSON.stringify({
          receiver_id: sender,
          amount: amountToClaim,
          msg: '',
        }),
        ONE_YOCTO,
        FIFTY_TGAS,
      )
      .then(
        NearPromise.new(near.currentAccountId()).functionCall(
          'finalize_claim_callback',
          JSON.stringify({
            address: sender,
            sessionId,
            amount: amountToClaim,
          }),
          NO_DEPOSIT,
          THIRTY_TGAS,
        ),
      )
  }

  @call({ privateFunction: true })
  finalize_claim_callback({ address, sessionId, amount }) {
    try {
      const session = this.sessions.get(sessionId)
      const players = UnorderedMap.reconstruct(session.players)
      const player = players.get(address)

      const { result, success } = promiseResult(0)
      near.log('in finalize_claim_callback: ', result, success)

      if (success) {
        players.set(address, { ...player, isClaimed: true })

        return '0'
      }

      return amount
    } catch (error) {
      near.log('finalizeClaimCallback failed')

      return amount
    }
  }

  @view({})
  get_player_chance({
    address,
    sessionId = this.currentSessionId,
  }: {
    address: string
    sessionId: string
  }): string {
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
    const winningNumber = session.winingNumbers[0]
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
  }: {
    address: string
    sessionId: string
  }): bigint[] {
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
    near.log('session', session)
    const players = UnorderedMap.reconstruct(session.players)

    return players.get(address)
  }

  @view({})
  get_storage_deposit({
    sessionId = this.currentSessionId,
    address,
  }: {
    sessionId: string
    address: string
  }): boolean {
    const session = this.sessions.get(sessionId)
    const storageDeposits = LookupMap.reconstruct<boolean>(session.storageDeposits)

    return storageDeposits.get(`${this.currentSessionId}:${address}`)
  }
}

export function promiseResult(index: number): {
  result: string
  success: boolean
} {
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
