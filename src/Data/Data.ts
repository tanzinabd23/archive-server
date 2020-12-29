import { Server, IncomingMessage, ServerResponse } from 'http'
import { EventEmitter } from 'events'
import * as deepmerge from 'deepmerge'
import fastify = require('fastify')
import * as Crypto from '../Crypto'
import * as NodeList from '../NodeList'
import * as Storage from '../Storage'
import * as Cycles from './Cycles'
import * as State from '../State'
import * as P2P from '../P2P'
import * as Utils from '../Utils'
import { isDeepStrictEqual } from 'util'
import {
  Cycle,
  currentCycleCounter,
  currentCycleDuration,
  processCycles,
  validateCycle
} from './Cycles'
import { Transaction } from './Transactions'
import { StateHashes, processStateHashes } from './State'
import { ReceiptHashes, processReceiptHashes, getReceiptMapHash } from './Receipt'
import { SummaryHashes, processSummaryHashes, getSummaryHash } from './Summary'
import { BaseModel } from 'tydb'
import { arch } from 'os'

// Socket modules
export let socketServer: SocketIO.Server
let ioclient: SocketIOClientStatic = require('socket.io-client')
let socketClient: SocketIOClientStatic["Socket"]

let verifiedReceiptMapResults: {
  [key: number]: { [key: number]: ReceiptMapResult }
} = {}

export interface StateMetaData {
  counter: Cycle['counter']
  stateHashes: StateHashes[],
  receiptHashes: ReceiptHashes[],
  summaryHashes: SummaryHashes[]
}
// Data types

export type ValidTypes = Cycle | StateMetaData

export enum TypeNames {
  CYCLE = 'CYCLE',
  STATE_METADATA = 'STATE_METADATA'
}

interface NamesToTypes {
  CYCLE: Cycle
  STATE_METADATA: StateMetaData
}

export type TypeName<T extends ValidTypes> = T extends Cycle
  ? TypeNames.CYCLE
  : TypeNames.STATE_METADATA

export type TypeIndex<T extends ValidTypes> = T extends Cycle
  ? Cycle['counter']
  : StateMetaData['counter']

// Data network messages

export interface DataRequest<T extends ValidTypes> {
  type: TypeName<T>
  lastData: TypeIndex<T>
}

interface DataResponse<T extends ValidTypes> {
  type: TypeName<T>
  data: T[]
}

interface DataKeepAlive {
  keepAlive: boolean
}

export type ReceiptMap = {[txId:string] : string[]  }

export type ReceiptMapResult = {
  cycle:number;
  partition:number;
  receiptMap:ReceiptMap;
  txCount:number
}

type OpaqueBlob = any

export type SummaryBlob = {
  latestCycle: number; //The highest cycle that was used in this summary.  
  counter:number; 
  errorNull:number; 
  partition:number; 
  opaqueBlob:OpaqueBlob;
}

//A collection of blobs that share the same cycle.  For TX summaries
type SummaryBlobCollection = {
  cycle:number; 
  blobsByPartition:Map<number, SummaryBlob>;
}

// Stats collected for a cycle
export type StatsClump = {
  error:boolean; 
  cycle:number; 
  dataStats:SummaryBlob[]; 
  txStats:SummaryBlob[]; 
  covered:number[];
  coveredParititionCount:number;
  skippedParitionCount:number; 
}

export interface ReceiptMapQueryResponse {
  success: boolean
  data: { [key: number]: ReceiptMapResult[]}
}
export interface SummaryBlobQueryResponse {
  success: boolean
  data: { [key: number]: SummaryBlob[]}
}
export interface DataQueryResponse {
  success: boolean
  data: any
}
type CycleMarker = string

type StateData = {
  parentCycle?: CycleMarker
  networkHash?: string
  partitionHashes?: string[]
}

type Receipt = {
  parentCycle?: CycleMarker
  networkHash?: string
  partitionHashes?: string[]
  partitionMaps?: { [partition: number]: ReceiptMapResult }
  partitionTxs?: { [partition: number]: any }
}

type Summary = {
  parentCycle?: CycleMarker
  networkHash?: string
  partitionHashes?: string[]
  partitionBlobs?: { [partition: number]: SummaryBlob }
}

export class ArchivedCycle extends BaseModel {
  cycleRecord!: Cycle
  cycleMarker!: CycleMarker
  data!: StateData
  receipt!: Receipt
  summary!: Summary
}

export function initSocketServer(io: SocketIO.Server) {
  socketServer = io
  socketServer.on('connection', (socket: SocketIO.Socket) => {
    console.log('Explorer has connected')
  })
}

export function disconnectSocketClient() {
  console.log('Disconnecting previous connection')
  socketClient.disconnect()
}

export function initSocketClient(node: NodeList.ConsensusNodeInfo) {
  console.log(node)
  socketClient = ioclient.connect(`http://${node.ip}:${node.port}`)

  socketClient.on('connect', () => {
    console.log('Connection to consensus node was made')
  })

  socketClient.on('DATA', (newData: any) => {
    console.log('DATA from consensor', newData)
    socketServer.emit('DATA', newData)

    const sender = dataSenders.get(newData.publicKey)

    // If publicKey is not in dataSenders, dont keepAlive, END
    if (!sender) {
      console.log('NO SENDER')
      return
    }

    // If unexpected data type from sender, dont keepAlive, END
    const newDataTypes = Object.keys(newData.responses)
    for (const type of newDataTypes as (keyof typeof TypeNames)[]) {
      if (sender.types.includes(type) === false) {
        console.log(
          `NEW DATA type ${type} not included in sender's types: ${JSON.stringify(
            sender.types
          )}`
        )
        return
      }
    }

    // If tag is invalid, dont keepAlive, END
    if (Crypto.authenticate(newData) === false) {
      console.log('Invalid tag')
      return
    }

    setImmediate(processData, newData)
  })
}

export function createDataRequest<T extends ValidTypes>(
  type: TypeName<T>,
  lastData: TypeIndex<T>,
  recipientPk: Crypto.types.publicKey
) {
  return Crypto.tag<DataRequest<T>>(
    {
      type,
      lastData,
    },
    recipientPk
  )
}

export function createQueryRequest<T extends ValidTypes>(
  type: string,
  lastData: number,
  recipientPk: Crypto.types.publicKey
) {
  return Crypto.tag(
    {
      type,
      lastData,
    },
    recipientPk
  )
}
// Vars to track Data senders

export interface DataSender {
  nodeInfo: NodeList.ConsensusNodeInfo
  types: (keyof typeof TypeNames)[]
  contactTimeout?: NodeJS.Timeout
}

export const dataSenders: Map<
  NodeList.ConsensusNodeInfo['publicKey'],
  DataSender
> = new Map()

const timeoutPadding = 1000

export const emitter = new EventEmitter()

function replaceDataSender(publicKey: NodeList.ConsensusNodeInfo['publicKey']) {
  if (NodeList.getActiveList().length < 2) {
    console.log(NodeList.getActiveList())
    console.log('There is only one active node in the network. Unable to replace data sender')
    let sender = dataSenders.get(publicKey)
    if (sender && sender.contactTimeout) {
      clearTimeout(sender.contactTimeout)
      sender.contactTimeout = createContactTimeout(publicKey)
    }
    return
  }
  console.log(`replaceDataSender: replacing ${publicKey}`)

  // Remove old dataSender
  const removedSenders = removeDataSenders(publicKey)
  if (removedSenders.length < 1) {
    // throw new Error('replaceDataSender failed: old sender not removed')
    console.log('replaceDataSender failed: old sender not removed')
  }
  // console.log(
  //   `replaceDataSender: removed old sender ${JSON.stringify(
  //     removedSenders,
  //     null,
  //     2
  //   )}`
  // )

  // Pick a new dataSender
  const newSenderInfo = selectNewDataSender()
  if (!newSenderInfo) {
    console.log('Unable to select a new data sender.')
    return
  }
  const newSender: DataSender = {
    nodeInfo: newSenderInfo,
    types: [TypeNames.CYCLE, TypeNames.STATE_METADATA],
    contactTimeout: createContactTimeout(newSenderInfo.publicKey),
  }
  // console.log(
  //   `replaceDataSender: selected new sender ${JSON.stringify(
  //     newSender.nodeInfo,
  //     null,
  //     2
  //   )}`
  // )

  // Add new dataSender to dataSenders
  addDataSenders(newSender)
  console.log(
    `replaceDataSender: added new sender ${newSenderInfo.publicKey} to dataSenders`
  )

  // Send dataRequest to new dataSender
  const dataRequest = {
    dataRequestCycle: createDataRequest<Cycle>(
      TypeNames.CYCLE,
      currentCycleCounter,
      publicKey
    ),
    dataRequestState: createDataRequest<StateMetaData>(
      TypeNames.STATE_METADATA,
      currentCycleCounter,
      publicKey
    )
  }

  sendDataRequest(newSender, dataRequest)

  // console.log(
  //   `replaceDataSender: sent dataRequest to new sender: ${JSON.stringify(
  //     dataRequest,
  //     null,
  //     2
  //   )}`
  // )
}

/**
 * Sets timeout to current cycle duration + some padding
 * Removes sender from dataSenders on timeout
 * Select a new dataSender
 */
export function createContactTimeout(
  publicKey: NodeList.ConsensusNodeInfo['publicKey']
) {
  // TODO: fix correct replace timeout
  const ms = 100 * currentCycleDuration || (30 * 60 * 1000) + timeoutPadding
  console.log(`Created replace timeout of ${ms} ms for ${publicKey}`)
  const contactTimeout = setTimeout(replaceDataSender, ms, publicKey)
  return contactTimeout
}

export function addDataSenders(...senders: DataSender[]) {
  for (const sender of senders) {
    dataSenders.set(sender.nodeInfo.publicKey, sender)
  }
}

function removeDataSenders (
  publicKey: NodeList.ConsensusNodeInfo['publicKey']
) {
  console.log(`Removing data sender ${publicKey}`)
  const removedSenders = []
  const sender = dataSenders.get(publicKey)
  if (sender) {
    // Clear contactTimeout associated with this sender
    if (sender.contactTimeout) {
      clearTimeout(sender.contactTimeout)
    }

    // Record which sender was removed
    removedSenders.push(sender)

    // Delete sender from dataSenders
    dataSenders.delete(publicKey)
  } else {
    console.log('Unable to find sender in the list', dataSenders)
  }

  return removedSenders
}


function selectNewDataSender() {
  // Randomly pick an active node
  const activeList = NodeList.getActiveList()
  const newSender = activeList[Math.floor(Math.random() * activeList.length)]
  console.log('New data sender is selected', newSender)
  if(newSender) {
    disconnectSocketClient()
    initSocketClient(newSender)
  }
  return newSender
}

export function sendDataRequest(
  sender: DataSender,
  dataRequest: any
) {
  // TODO: crypto.tag cannot handle array type. To change something else
  const taggedDataRequest = Crypto.tag(dataRequest, sender.nodeInfo.publicKey)
  emitter.emit('selectNewDataSender', sender.nodeInfo, taggedDataRequest)
}

export function sendJoinRequest (nodeInfo: NodeList.ConsensusNodeInfo) {
  let joinRequest = P2P.createArchiverJoinRequest()
  emitter.emit('submitJoinRequest', nodeInfo, joinRequest)
}

export async function getCycleDuration () {
  let cycleDuration
  const randomIndex = Math.floor(Math.random() * State.activeArchivers.length)
  const randomArchiver = State.activeArchivers[randomIndex]
  let response: any = await P2P.getJson(
    `http://${randomArchiver.ip}:${randomArchiver.port}/cycleinfo/1`)
  if (response && response.cycleInfo) {
    return response.cycleInfo[0].duration
  }
}
export function checkJoinStatus (cycleDuration: number): Promise<boolean> {
  if (!cycleDuration) {
    console.log('No cycle duration provided')
    throw new Error('No cycle duration provided')
  }
  console.log('cycle duration', cycleDuration)
  const ourNodeInfo = State.getNodeInfo()
  const randomIndex = Math.floor(Math.random() * State.activeArchivers.length)
  const randomArchiver = State.activeArchivers[randomIndex]

  return new Promise(resolve => {
    async function fetchJoinedArchiverList () {
      console.log(
        'Asking join status from random archiver',
        randomArchiver.port
      )
      let response: any = await P2P.getJson(
        `http://${randomArchiver.ip}:${randomArchiver.port}/cycleinfo/1`
      )
      try {
        if (response && response.cycleInfo[0] && response.cycleInfo[0].joinedArchivers) {
          let joinedArchivers = response.cycleInfo[0].joinedArchivers
          console.log('Joined archivers', joinedArchivers)
          let isJoind = joinedArchivers.includes(
            (a: any) => a.publicKey === ourNodeInfo.publicKey
          )
          console.log('isJoind', isJoind)
          resolve(true)
        } else {
          setTimeout(fetchJoinedArchiverList, cycleDuration * 1000 + Date.now())
        }
      } catch (e) {
        console.log(e)
        setTimeout(fetchJoinedArchiverList, cycleDuration * 1000 + Date.now())
      }
    }

    setTimeout(fetchJoinedArchiverList, cycleDuration * 1000 + Date.now())
  })
}


function sendDataQuery(
  consensorNode: NodeList.ConsensusNodeInfo,
  dataQuery: any
) {
  // TODO: crypto.tag cannot handle array type. To change something else
  const taggedDataQuery = Crypto.tag(dataQuery, consensorNode.publicKey)
  queryDataFromNode(consensorNode, taggedDataQuery)
}

async function processData(newData: DataResponse<ValidTypes> & Crypto.TaggedMessage) {
  console.log('processing data')
  // Get sender entry
  const sender = dataSenders.get(newData.publicKey)

  // If no sender entry, remove publicKey from senders, END
  if (!sender) {
    console.log('No sender found')
    return
  }

  // Clear senders contactTimeout, if it has one
  if (sender.contactTimeout) {
    clearTimeout(sender.contactTimeout)
  }

  const newDataTypes = Object.keys(newData.responses)
  for (const type of newDataTypes as (keyof typeof TypeNames)[]) {

    // Process data depending on type
    switch (type) {
      case TypeNames.CYCLE: {
        // Process cycles
        processCycles(newData.responses.CYCLE as Cycle[])
        if (newData.responses.CYCLE.length > 0) {
          let archivedCycle: any = {}
          archivedCycle.cycleRecord = newData.responses.CYCLE[0]
          archivedCycle.cycleMarker = newData.responses.CYCLE[0].marker
          Cycles.CycleChain.set(newData.responses.CYCLE[0].counter, newData.responses.CYCLE[0])
          await Storage.insertArchivedCycle(archivedCycle)
        }
        break
      }
      case TypeNames.STATE_METADATA: {
        let stateMetaData: StateMetaData = newData.responses.STATE_METADATA[0]
        let data, receipt, summary
        // [TODO] validate the state data by robust querying other nodes
        processStateHashes(stateMetaData.stateHashes as StateHashes[])
        processSummaryHashes(stateMetaData.summaryHashes as SummaryHashes[])
        processReceiptHashes(stateMetaData.receiptHashes as ReceiptHashes[])

        if (stateMetaData.stateHashes.length > 0) {
          let parentCycle = Cycles.CycleChain.get(stateMetaData.stateHashes[0].counter)
          if (!parentCycle) {
            console.log('Unable to find parent cycle for cycle', stateMetaData.stateHashes[0].counter)
            return
          }
          data = {
            parentCycle: parentCycle ? parentCycle.marker : '',
            networkHash: stateMetaData.stateHashes[0].networkHash,
            partitionHashes: stateMetaData.stateHashes[0].partitionHashes,
          }
          await Storage.updateArchivedCycle(data.parentCycle, 'data', data)
        }

        if (stateMetaData.receiptHashes.length > 0) {
          let parentCycle = Cycles.CycleChain.get(
            stateMetaData.receiptHashes[0].counter
          )

          if (!parentCycle) {
            console.log('Unable to find parent cycle for cycle', stateMetaData.stateHashes[0].counter)
            return
          }

          receipt = {
            parentCycle: parentCycle ? parentCycle.marker : '',
            networkHash: stateMetaData.receiptHashes[0].networkReceiptHash,
            partitionHashes: stateMetaData.receiptHashes[0].receiptMapHashes,
            partitionMaps: {},
            partitionTxs: {},
          }
          await Storage.updateArchivedCycle(receipt.parentCycle, 'receipt', receipt)
        }

        if (stateMetaData.summaryHashes.length > 0) {
          let parentCycle = Cycles.CycleChain.get(
            stateMetaData.summaryHashes[0].counter
          )

          if (!parentCycle) {
            console.log('Unable to find parent cycle for cycle', stateMetaData.stateHashes[0].counter)
            return
          }

          summary = {
            parentCycle: parentCycle ? parentCycle.marker : '',
            networkHash: stateMetaData.summaryHashes[0].networkSummaryHash,
            partitionHashes: stateMetaData.summaryHashes[0].summaryHashes,
            partitionBlobs: {},
          }
          await Storage.updateArchivedCycle(summary.parentCycle, 'summary', summary)
        }

        // Query receipt maps from other nodes and store it
        if (stateMetaData.receiptHashes.length > 0) {
          let activeNodes = NodeList.getActiveList()
          for (let node of activeNodes) {
            const queryRequest = createQueryRequest('RECEIPT_MAP', stateMetaData.receiptHashes[0].counter, node.publicKey)
            sendDataQuery(node, queryRequest)
          }
        }

        // Query summary blobs from other nodes and store it
        if (stateMetaData.summaryHashes.length > 0) {
          let activeNodes = NodeList.getActiveList()
          for (let node of activeNodes) {
            const queryRequest = createQueryRequest('SUMMARY_BLOB', stateMetaData.summaryHashes[0].counter, node.publicKey)
            sendDataQuery(node, queryRequest)
          }
        }
        break
      }
      default: {
        // If data type not recognized, remove sender from dataSenders
        console.log('Unknow data type detected', type)
        removeDataSenders(newData.publicKey)
      }
    }
  }

  // Set new contactTimeout for sender. Postpone sender removal because data is still received from consensor
  if (currentCycleDuration > 0) {
    sender.contactTimeout = createContactTimeout(sender.nodeInfo.publicKey)
  }
}

export async function fetchStateHashes (archivers: any) {
  function _isSameStateHashes (info1: any, info2: any ) {
    const cm1 = Utils.deepCopy(info1)
    const cm2 = Utils.deepCopy(info2)
    delete cm1.currentTime
    delete cm2.currentTime
    const equivalent = isDeepStrictEqual(cm1, cm2)
    return equivalent
  }

  const queryFn = async (node: any) => {
    const response: any = await P2P.getJson(
      `http://${node.ip}:${node.port}/statehashes`
    )
    return response.stateHashes
  }
  const stateHashes:any = await Utils.robustQuery(
    archivers,
    queryFn,
    _isSameStateHashes
  )
  return stateHashes[0]
}

export async function fetchCycleRecords(activeArchivers: State.ArchiverNodeInfo[], start:number, end: number): Promise<any> {
  function isSameCyceInfo (info1: any, info2: any) {
    const cm1 = Utils.deepCopy(info1)
    const cm2 = Utils.deepCopy(info2)
    delete cm1.currentTime
    delete cm2.currentTime
    const equivalent = isDeepStrictEqual(cm1, cm2)
    return equivalent
  }

  const queryFn = async (node: any) => {
    const response: any = await P2P.getJson(
      `http://${node.ip}:${node.port}/cycleinfo?start=${start}&end=${end}`
    )
    return response.cycleInfo
  }
  const { result } = await Utils.sequentialQuery(activeArchivers, queryFn)
  return result
}

export async function getNewestCycle(activeArchivers: State.ArchiverNodeInfo[]): Promise<any> {
  function isSameCyceInfo (info1: any, info2: any) {
    const cm1 = Utils.deepCopy(info1)
    const cm2 = Utils.deepCopy(info2)
    delete cm1.currentTime
    delete cm2.currentTime
    const equivalent = isDeepStrictEqual(cm1, cm2)
    return equivalent
  }

  const queryFn = async (node: any) => {
    const response: any = await P2P.getJson(
      `http://${node.ip}:${node.port}/cycleinfo/1`
    )
    return response.cycleInfo
  }
  let cycleInfo: any = await Utils.robustQuery(
    activeArchivers,
    queryFn,
    isSameCyceInfo
  )
  return cycleInfo[0]
}

export function activeNodeCount(cycle: Cycle) {
  return (
    cycle.active +
    cycle.activated.length -
    cycle.apoptosized.length -
    cycle.removed.length -
    cycle.lost.length
  )
}

export function totalNodeCount(cycle: Cycle) {
  return (
    cycle.syncing +
    cycle.joinedConsensors.length +
    cycle.active +
    //    cycle.activated.length -      // don't count activated because it was already counted in syncing
    cycle.apoptosized.length -
    cycle.removed.length -
    cycle.lost.length
  )
}

export interface JoinedConsensor extends NodeList.ConsensusNodeInfo {
  cycleJoined: string
  counterRefreshed: number
  id: string
}

export enum NodeStatus {
  ACTIVE = 'active',
  SYNCING = 'syncing',
  REMOVED = 'removed',
}

export interface Node extends JoinedConsensor {
  curvePublicKey: string
  status: NodeStatus
}


type OptionalExceptFor<T, TRequired extends keyof T> = Partial<T> &
  Pick<T, TRequired>

export type Update = OptionalExceptFor<Node, 'id'>

export interface Change {
  added: JoinedConsensor[] // order joinRequestTimestamp [OLD, ..., NEW]
  removed: Array<string> // order doesn't matter
  updated: Update[] // order doesn't matter
}

export function reversed<T>(thing: Iterable<T>) {
  const arr = Array.isArray(thing) ? thing : Array.from(thing)
  let i = arr.length - 1
  const reverseIterator = {
    next: () => {
      const done = i < 0
      const value = done ? undefined : arr[i]
      i--
      return { value, done }
    },
  }
  return {
    [Symbol.iterator]: () => reverseIterator,
  }
}

export class ChangeSquasher {
  final: Change
  removedIds: Set<Node['id']>
  seenUpdates: Map<Update['id'], Update>
  addedIds: Set<Node['id']>
  constructor () {
    this.final = {
      added: [],
      removed: [],
      updated: [],
    }
    this.addedIds = new Set()
    this.removedIds = new Set()
    this.seenUpdates = new Map()
  }

  addChange (change: Change) {
    for (const id of change.removed) {
      // Ignore if id is already removed
      if (this.removedIds.has(id)) continue
      // Mark this id as removed
      this.removedIds.add(id)
    }

    for (const update of change.updated) {
      // Ignore if update.id is already removed
      if (this.removedIds.has(update.id)) continue
      // Mark this id as updated
      this.seenUpdates.set(update.id, update)
    }

    for (const joinedConsensor of reversed(change.added)) {
      // Ignore if it's already been added
      if (this.addedIds.has(joinedConsensor.id)) continue

      // Ignore if joinedConsensor.id is already removed
      if (this.removedIds.has(joinedConsensor.id)) {
        continue
      }
      // Check if this id has updates
      const update = this.seenUpdates.get(joinedConsensor.id)
      if (update) {
        // If so, put them into final.updated
        this.final.updated.unshift(update)
        this.seenUpdates.delete(joinedConsensor.id)
      }
      // Add joinedConsensor to final.added
      this.final.added.unshift(joinedConsensor)
      // Mark this id as added
      this.addedIds.add(joinedConsensor.id)
    }
  }
}

export function parseRecord (record: any): Change {
  // For all nodes described by activated, make an update to change their status to active
  const activated = record.activated.map((id: string) => ({
    id,
    activeTimestamp: record.start,
    status: NodeStatus.ACTIVE,
  }))

  const refreshAdded: Change['added'] = []
  const refreshUpdated: Change['updated'] = []
  for (const refreshed of record.refreshedConsensors) {
    // const node = NodeList.nodes.get(refreshed.id)
    const node = NodeList.getNodeInfoById(refreshed.id) as JoinedConsensor
    if (node) {
      // If it's in our node list, we update its counterRefreshed
      // (IMPORTANT: update counterRefreshed only if its greater than ours)
      if (record.counter > node.counterRefreshed) {
        refreshUpdated.push({
          id: refreshed.id,
          counterRefreshed: record.counter,
        })
      }
    } else {
      // If it's not in our node list, we add it...
      refreshAdded.push(refreshed)
      // and immediately update its status to ACTIVE
      // (IMPORTANT: update counterRefreshed to the records counter)
      refreshUpdated.push({
        id: refreshed.id,
        status: NodeStatus.ACTIVE,
        counterRefreshed: record.counter,
      })
    }
  }

  return {
    added: [...record.joinedConsensors],
    removed: [...record.apoptosized],
    updated: [...activated, refreshUpdated],
  }
}

export function parse (record: any): Change {
  const changes = parseRecord(record)
  // const mergedChange = deepmerge.all<Change>(changes)
  // return mergedChange
  return changes
}

function applyNodeListChange(change: Change) {
  if (change.added.length > 0) {
    const consensorInfos = change.added.map((jc: any) => ({
      ip: jc.externalIp,
      port: jc.externalPort,
      publicKey: jc.publicKey,
      id: jc.id,
    }))

    NodeList.addNodes(NodeList.Statuses.ACTIVE, change.added[0].cycleJoined, consensorInfos)
  }
  if (change.removed.length > 0) {
    NodeList.removeNodes(change.removed)
  }
}

export async function syncCyclesAndNodeList (activeArchivers: State.ArchiverNodeInfo[]) {
  // Get the networks newest cycle as the anchor point for sync
  console.log('Getting newest cycle...')
  const [cycleToSyncTo] = await getNewestCycle(activeArchivers)
  console.log('cycleToSyncTo', cycleToSyncTo)
  console.log(`Syncing till cycle ${cycleToSyncTo.counter}...`)
  const cyclesToGet = 2 * Math.floor(Math.sqrt(cycleToSyncTo.active)) + 2
  console.log(`Cycles to get is ${cyclesToGet}`)

  let CycleChain = []
  const squasher = new ChangeSquasher()

  CycleChain.unshift(cycleToSyncTo)
  squasher.addChange(parse(CycleChain[0]))

  do {
    // Get prevCycles from the network
    const end: number = CycleChain[0].counter - 1
    const start: number = end - cyclesToGet
    console.log(`Getting cycles ${start} - ${end}...`)
    const prevCycles = await fetchCycleRecords(activeArchivers, start, end)

    // If prevCycles is empty, start over
    if (prevCycles.length < 1) throw new Error('Got empty previous cycles')

    // Add prevCycles to our cycle chain
    let prepended = 0
    for (const prevCycle of prevCycles) {
      // Stop prepending prevCycles if one of them is invalid
      if (validateCycle(prevCycle, CycleChain[0]) === false) {
        console.log(`Record ${prevCycle.counter} failed validation`)
        break
      }
      // Prepend the cycle to our cycle chain
      CycleChain.unshift(prevCycle)
      squasher.addChange(parse(prevCycle))
      prepended++

      if (
        squasher.final.updated.length >= activeNodeCount(cycleToSyncTo) &&
        squasher.final.added.length >= totalNodeCount(cycleToSyncTo)
      ) {
        break
      }
    }

    console.log(
      `Got ${
        squasher.final.updated.length
      } active nodes, need ${activeNodeCount(cycleToSyncTo)}`
    )
    console.log(
      `Got ${squasher.final.added.length} total nodes, need ${totalNodeCount(
        cycleToSyncTo
      )}`
    )
    if (squasher.final.added.length < totalNodeCount(cycleToSyncTo))
      console.log(
        'Short on nodes. Need to get more cycles. Cycle:' +
          cycleToSyncTo.counter
      )

    // If you weren't able to prepend any of the prevCycles, start over
    if (prepended < 1) throw new Error('Unable to prepend any previous cycles')
  } while (
    squasher.final.updated.length < activeNodeCount(cycleToSyncTo) ||
    squasher.final.added.length < totalNodeCount(cycleToSyncTo)
  )

  applyNodeListChange(squasher.final)
  console.log('NodeList after sync', NodeList.getActiveList())

  // await Storage.storeCycles(CycleChain)
  for (let i = 0; i < CycleChain.length; i++) {
    let record = CycleChain[i]
    console.log('Inserting archived cycle', record.counter)
    Cycles.CycleChain.set(record.counter, {...record})
    const archivedCycle = createArchivedCycle(record)
    await Storage.insertArchivedCycle(archivedCycle)
  }
  console.log('Cycle chain is synced. Size of CycleChain', Cycles.CycleChain.size)
  return true
}

function createArchivedCycle(cycleRecord: Cycle) {
  let archivedCycle: any = {
    cycleRecord: cycleRecord,
    cycleMarker: cycleRecord.marker,
    data: {},
    receipt: {},
    summary: {}
  }
  return archivedCycle
}

async function downloadArchivedCycles(archiver: State.ArchiverNodeInfo) {
  let response: any = await P2P.getJson(
    `http://${archiver.ip}:${archiver.port}/full-archive`)
  if (response && response.archivedCycles) {
    return response.archivedCycles
  }
}

export async function syncStateMetaData (activeArchivers: State.ArchiverNodeInfo[]) {
  const randomIndex = Math.floor(Math.random() * activeArchivers.length)
  const randomArchiver = activeArchivers[randomIndex]
  let downloadedArchivedCycles = await downloadArchivedCycles(randomArchiver)
  let allCycleRecords = await Storage.queryAllCycleRecords()
  let networkReceiptHashesFromRecords = new Map()
  let networkDataHashesFromRecords = new Map()
  let networkSummaryHashesFromRecords = new Map()

  allCycleRecords.forEach((cycleRecord: any) => {
    if (cycleRecord.networkReceiptHash.length > 0) {
      cycleRecord.networkReceiptHash.forEach((hash: any) => {
        networkReceiptHashesFromRecords.set(hash.cycle, hash.hash)
      })
    }
    if (cycleRecord.networkDataHash.length > 0) {
      cycleRecord.networkDataHash.forEach((hash: any) => {
        networkDataHashesFromRecords.set(hash.cycle, hash.hash)
      })
    }
    if (cycleRecord.networkSummaryHash.length > 0) {
      cycleRecord.networkSummaryHash.forEach((hash: any) => {
        networkSummaryHashesFromRecords.set(hash.cycle, hash.hash)
      })
    }
  })

  for (let i = 0; i < allCycleRecords.length; i++) {
    let marker = allCycleRecords[i].marker
    let counter = allCycleRecords[i].counter
    let foundArchiveCycle = downloadedArchivedCycles.find(
      (archive: any) => archive.cycleMarker === marker
    )
    // Check and store data hashes
    if (foundArchiveCycle.data) {
      let downloadedNetworkDataHash = foundArchiveCycle.data.networkHash

      // console.log('downloadedNetworkDataHash', downloadedNetworkDataHash)
      // console.log('networkDataHashesFromRecords', networkDataHashesFromRecords.get(counter))
  
      if (downloadedNetworkDataHash === networkDataHashesFromRecords.get(counter)) {
        console.log('Network data hash matches')
        Storage.updateArchivedCycle(marker, 'data', foundArchiveCycle.data)
      }
    } else {
      console.log(`ArchivedCycle ${foundArchiveCycle.cycleRecord.counter}, ${foundArchiveCycle.cycleMarker} does not have data field`)
    }

    // Check and store receipt hashes + receiptMap
    if (foundArchiveCycle.receipt) {
      // TODO: calcuate the network hash by hashing downloaded receipt Map instead of using downloadedNetworkReceiptHash
      let downloadedNetworkReceiptHash = foundArchiveCycle.receipt.networkHash
      
      // console.log('downloadedNetworkReceiptHash', downloadedNetworkReceiptHash)
      // console.log('networkReceiptHashesFromRecords', networkReceiptHashesFromRecords.get(counter))
  
      if (downloadedNetworkReceiptHash === networkReceiptHashesFromRecords.get(counter)) {
        console.log('Network receipt hash matches')
        Storage.updateArchivedCycle(marker, 'receipt', foundArchiveCycle.receipt)
      }
    } else {
      console.log(`ArchivedCycle ${foundArchiveCycle.cycleRecord.counter}, ${foundArchiveCycle.cycleMarker} does not have receipt field`)
    }

    // Check and store summary hashes
    if (foundArchiveCycle.summary) {
      // TODO: calcuate the network hash by hashing downloaded summary Blobs instead of using downloadedNetworkSummaryHash
      let downloadedNetworkSummaryHash = foundArchiveCycle.summary.networkHash

      // console.log('downloadedNetworkSummaryHash', downloadedNetworkSummaryHash)
      // console.log('networkSummaryHashesFromRecords', networkSummaryHashesFromRecords.get(counter))
  
      if (downloadedNetworkSummaryHash === networkSummaryHashesFromRecords.get(counter)) {
        console.log('Network summary hash matches')
        Storage.updateArchivedCycle(marker, 'summary', foundArchiveCycle.summary)
      }
    } else {
      console.log(`ArchivedCycle ${foundArchiveCycle.cycleRecord.counter}, ${foundArchiveCycle.cycleMarker} does not have summary field`)
    }
  }
}

async function queryDataFromNode (
  newSenderInfo: NodeList.ConsensusNodeInfo,
  dataQuery: any
) {
  let request = {
    ...dataQuery,
    nodeInfo: State.getNodeInfo(),
  }
  let response = await P2P.postJson(
    `http://${newSenderInfo.ip}:${newSenderInfo.port}/querydata`,
    request
  )
  if (response && request.type === 'RECEIPT_MAP') {
    for (let counter in response.data) {
      validateAndStoreReceiptMaps(response.data)
    }
  } else if (response && request.type === 'SUMMARY_BLOB') {
    for (let counter in response.data) {
      validateAndStoreSummaryBlobs(Object.values(response.data))
    }
  }
}

async function validateAndStoreReceiptMaps (receiptMapResultsForCycles: {
  [key: number]: ReceiptMapResult[]
}) {
  for (let counter in receiptMapResultsForCycles) {
    let receiptMapResults: ReceiptMapResult[] =
      receiptMapResultsForCycles[counter]
    for (let partitionBlock of receiptMapResults) {
      let { partition } = partitionBlock
      let reciptMapHash = await getReceiptMapHash(parseInt(counter), partition)
      let calculatedReceiptMapHash = Crypto.hashObj(partitionBlock)
      if (calculatedReceiptMapHash === reciptMapHash) {
        await Storage.storeReceiptMap(partitionBlock)
        await Storage.updateReceiptMap(partitionBlock)

      }
    }
  }
}

async function validateAndStoreSummaryBlobs (
  statsClumpForCycles: StatsClump[]
) {
  for (let statsClump of statsClumpForCycles) {

    let { cycle, dataStats, txStats, covered } = statsClump
    let blobsToForward = []

    for (let partition of covered) {
      let summaryBlob
      let dataBlob = dataStats.find(d => d.partition === partition)
      let txBlob = txStats.find(t => t.partition === partition)
      let summaryHash = await getSummaryHash(cycle, partition)
      let calculatedSummaryHash = Crypto.hashObj({
        dataStat: dataBlob,
        txStats: txBlob,
      })
      if (summaryHash !== calculatedSummaryHash) return
      if (dataBlob) {
        summaryBlob = {
          ...dataBlob,
        }
      }
      if (txBlob) {
        if (!summaryBlob) {
          summaryBlob = {
            ...txBlob
          }
        } else if (summaryBlob) {
          summaryBlob.latestCycle = txBlob.latestCycle
          summaryBlob.opaqueBlob = {
            ...summaryBlob.opaqueBlob,
            ...txBlob.opaqueBlob,
          }
        }
      }
      if (summaryBlob) {
        blobsToForward.push(summaryBlob)
        try {
          await Storage.storeSummaryBlob(summaryBlob, cycle)
          await Storage.updateSummaryBlob(summaryBlob, cycle)
        } catch (e) {
          console.log('Unable to store summary blob', e)
        }
      }
    }
    socketServer.emit('SUMMARY_BLOB', {blobs: blobsToForward, cycle})
  }
}

emitter.on(
  'selectNewDataSender',
  async (
    newSenderInfo: NodeList.ConsensusNodeInfo,
    dataRequest: any
  ) => {
    let request = {
      ...dataRequest,
      nodeInfo: State.getNodeInfo()
    }
    // console.log('Sending data request to: ', newSenderInfo.port)
    let response = await P2P.postJson(
      `http://${newSenderInfo.ip}:${newSenderInfo.port}/requestdata`,
      request
    )
    console.log('Data request response:', response)
  }
)

emitter.on(
  'submitJoinRequest',
  async (
    newSenderInfo: NodeList.ConsensusNodeInfo,
    joinRequest: any
  ) => {
    let request = {
      ...joinRequest,
      nodeInfo: State.getNodeInfo()
    }
    console.log('join request', request)
    console.log('Sending join request to: ', newSenderInfo.port)
    let response = await P2P.postJson(
      `http://${newSenderInfo.ip}:${newSenderInfo.port}/joinarchiver`,
      request
    )
    console.log('Join request response:', response)
  }
)
