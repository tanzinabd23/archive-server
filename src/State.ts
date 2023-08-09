import { Config } from './Config'
import * as Crypto from './Crypto'
import * as P2P from './P2P'
import * as NodeList from './NodeList'
import * as Data from './Data/Data'
import * as Utils from './Utils'
import * as Logger from './Logger'
import { getFinalArchiverList } from '@shardus/archiver-discovery'
import * as ShardusCrypto from '@shardus/crypto-utils'

export interface ArchiverNodeState {
  ip: string
  port: number
  publicKey: Crypto.types.publicKey
  secretKey: Crypto.types.secretKey
  curvePk: Crypto.types.curvePublicKey
  curveSk: Crypto.types.curveSecretKey
}

export type ArchiverNodeInfo = Omit<ArchiverNodeState, 'secretKey' | 'curveSk'>

const nodeState: ArchiverNodeState = {
  ip: '',
  port: -1,
  publicKey: '',
  secretKey: '',
  curvePk: '',
  curveSk: '',
}
export let existingArchivers: ArchiverNodeInfo[] = []
export let activeArchivers: ArchiverNodeInfo[] = []
export let isFirst = false
export let archiversReputation: Map<string, string> = new Map()

export async function initFromConfig(config: Config) {
  // Get own nodeInfo from config
  nodeState.ip = config.ARCHIVER_IP
  nodeState.port = config.ARCHIVER_PORT
  nodeState.publicKey = config.ARCHIVER_PUBLIC_KEY
  nodeState.secretKey = config.ARCHIVER_SECRET_KEY
  nodeState.curvePk = Crypto.core.convertPkToCurve(nodeState.publicKey)
  nodeState.curveSk = Crypto.core.convertSkToCurve(nodeState.secretKey)

  // Parse existing archivers list
  try {
    console.log('ARCHIVER_INFO', process.env.ARCHIVER_INFO)
    console.log('Getting existing archivers list from archiver-discovery.')
    existingArchivers = getFinalArchiverList().map(({ ip, port, publicKey }) => ({
      ip,
      port,
      publicKey,
      curvePk: ShardusCrypto.convertPkToCurve(publicKey),
    }))
    console.log(`Got existing archivers list using archiver-discovery. [count: ${existingArchivers.length}]`)
  } catch (e) {
    console.warn('No existing archivers were found:', JSON.stringify(e))
  }

  if (existingArchivers.length === 0) {
    console.log('No existing archivers were found. This is the first archiver.')
    isFirst = true
    return
  }

  let retryCount = 1
  let waitTime = 1000 * 60

  while (retryCount < 10 && activeArchivers.length === 0) {
    Logger.mainLogger.debug(`Getting consensor list from other achivers. [round: ${retryCount}]`)
    for (let i = 0; i < existingArchivers.length; i++) {
      if (existingArchivers[i].publicKey === nodeState.publicKey) {
        continue
      }
      let response: any = await P2P.getJson(
        `http://${existingArchivers[i].ip}:${existingArchivers[i].port}/nodelist`
      )
      Logger.mainLogger.debug(
        'response',
        `http://${existingArchivers[i].ip}:${existingArchivers[i].port}/nodelist`,
        response
      )
      if (!response) {
        Logger.mainLogger.warn(`No response when fetching from archiver ${existingArchivers[i].ip}:${existingArchivers[i].port}`)
        continue
      }
      if (!ShardusCrypto.verifyObj(response)) {
        /* prettier-ignore */ console.log(`Invalid signature when fetching from archiver ${existingArchivers[i].ip}:${existingArchivers[i].port}`)
        continue
      }
      if (response && response.nodeList && response.nodeList.length > 0) {
        activeArchivers.push(existingArchivers[i])
      }
    }
    if (activeArchivers.length === 0) {
      Logger.mainLogger.error(`Unable to find active archivers. Waiting for ${waitTime} before trying again.`)
      // wait for 1 min before retrying
      await Utils.sleep(waitTime)
      retryCount += 1
    }
  }
  if (activeArchivers.length === 0) {
    Logger.mainLogger.error(
      `We have tried ${retryCount} times to get nodeList from other archivers. But got no response or empty list. About to exit now.`
    )
    process.exit(0)
  }
}

export async function exitArchiver() {
  try {
    const randomConsensor: NodeList.ConsensusNodeInfo = NodeList.getRandomActiveNodes()[0]
    if (randomConsensor) {
      // Send a leave request to a random consensus node from the nodelist
      let isLeaveRequestSent = await Data.sendLeaveRequest(randomConsensor)
      Logger.mainLogger.debug('isLeaveRequestSent', isLeaveRequestSent)
      if (isLeaveRequestSent) {
        Logger.mainLogger.debug('Archiver will exit in 3 seconds.')
        setTimeout(process.exit, 3000)
      }
    } else {
      Logger.mainLogger.debug('Archiver will exit in 3 seconds.')
      setTimeout(() => {
        process.exit()
      }, 3000)
    }
  } catch (e) {
    Logger.mainLogger.error(e)
  }
}

export function addSigListeners(sigint = true, sigterm = true) {
  if (sigint) {
    process.on('SIGINT', async () => {
      Logger.mainLogger.debug('Exiting on SIGINT')
      exitArchiver()
    })
  }
  if (sigterm) {
    process.on('SIGTERM', async () => {
      Logger.mainLogger.debug('Exiting on SIGTERM')
      exitArchiver()
    })
  }
  Logger.mainLogger.debug('Registerd exit signal listeners.')
}

export function removeActiveArchiver(publicKey: string) {
  activeArchivers = activeArchivers.filter((a: any) => a.publicKey !== publicKey)
}

export function getNodeInfo(): ArchiverNodeInfo {
  const sanitizedNodeInfo = { ...nodeState }
  delete sanitizedNodeInfo.secretKey
  delete sanitizedNodeInfo.curveSk
  return sanitizedNodeInfo
}

export function getSecretKey() {
  return nodeState.secretKey
}

export function getCurveSk() {
  return nodeState.curveSk
}

export function getCurvePk() {
  return nodeState.curvePk
}
