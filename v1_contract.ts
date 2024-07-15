// Find all our documentation at https://docs.near.org
import { assert, NearBindgen, UnorderedMap, call, near, view } from 'near-sdk-js'

type Pool = {
  id: string
  yieldSourceContract: string
  currentSessionId: string
  sessions: UnorderedMap<Session>
}

type Player = {
  tickets: bigint
  amount: bigint
}

type Session = {
  id: string
  totalTickets: bigint
  players: {
    // Addres => Player (in native currency)
    [key: string]: Player
  }
  duration: bigint
  start: bigint
  end: bigint
  countOfWinNumbers: number
}

@NearBindgen({})
class FunStake {
  pools = new UnorderedMap<Pool>('pools')
  day = BigInt(86400)
  admin = ''

  constructor() {
    this.admin = near.predecessorAccountId()
  }

  @view({})
  private isAdmin(): void {
    assert(near.predecessorAccountId() === this.admin, 'Only admin can call this method')
  }

  // Only admin
  @call({})
  public createPool({ yieldSourceContract }: { yieldSourceContract: string }): void {
    this.isAdmin()

    const newId = String(this.pools.length)

    const pool: Pool = {
      id: newId,
      yieldSourceContract,
      currentSessionId: '0',
      sessions: new UnorderedMap<Session>('sessions'),
    }

    this.pools.set(newId, pool)
  }

  @call({})
  public stake({ poolId }: { poolId: string }): void {
    const pool = this.pools.get(poolId)
    const session = pool.sessions.get(pool.currentSessionId)
    const sender = near.predecessorAccountId()
    const value = near.attachedDeposit()

    if (!session.players[sender]) {
      session.players[sender].amount = value
    } else {
      session.players[sender].amount += value
    }

    const pastTime = near.blockTimestamp() - session.start
    const userTickets = session.players[sender].tickets
    // Do we need to caluclate based on day or just seconds
    const remainingTime = session.end - near.blockTimestamp()
    // const remainingDays = session.duration / this.day - pastTime / this.day
    const newTotalUsertickets = userTickets + remainingTime * value

    session.players[sender].tickets = newTotalUsertickets
    session.totalTickets += newTotalUsertickets
  }

  // Only Admin
  public startSession({
    poolId,
    duration,
    countOfWinNumbers,
  }: { poolId: string; duration: bigint; countOfWinNumbers: number }): void {
    const pool = this.pools.get(poolId)
    const newSessionId = String(pool.sessions.length)

    const session: Session = {
      id: newSessionId,
      players: {},
      duration,
      start: near.blockTimestamp(),
      end: near.blockTimestamp() + duration,
      totalTickets: BigInt(0),
      countOfWinNumbers,
    }

    pool.sessions.set(newSessionId, session)
    pool.currentSessionId = newSessionId
  }

  public finalizeSession({ poolId }: { poolId: string }): void {
    const pool = this.pools.get(poolId)
    const session = pool.sessions.get(pool.currentSessionId)

    assert(near.blockTimestamp() > session.end, 'Session is not ended yet')

    const winingNumbers = []
    for (let i = 0; i < session.countOfWinNumbers; i++) {
      const randomString = near.randomSeed()
      const firstChar = randomString.toString().charCodeAt(0)

      winingNumbers.push(BigInt(firstChar) % session.totalTickets)
    }

    // TODO: Transfer the yield to the winner
  }
}
