import * as db from './sqlite3storage'
import { extractValues, extractValuesFromArray } from './sqlite3storage'
import { P2P, StateManager } from '@shardus/types'
import * as Logger from '../Logger'
import { config } from '../Config'
import { DeSerializeFromJsonString, SerializeToJsonString } from '../utils/serialization'
import { CycleRecord } from '@shardus/types/build/src/p2p/CycleCreatorTypes'
import { Cycle as CyclesCycle } from '../Data/Cycles'

export interface Cycle {
  counter: number
  cycleRecord: P2P.CycleCreatorTypes.CycleRecord
  cycleMarker: StateManager.StateMetaDataTypes.CycleMarker
}

type DbCycle = Cycle & {
  cycleRecord: string
  cycleMarker: string
}

export async function insertCycle(cycle: Cycle): Promise<void> {
  try {
    const fields = Object.keys(cycle).join(', ')
    const placeholders = Object.keys(cycle).fill('?').join(', ')
    const values = extractValues(cycle)
    const sql = 'INSERT OR REPLACE INTO cycles (' + fields + ') VALUES (' + placeholders + ')'
    await db.run(sql, values)
    Logger.mainLogger.debug('Successfully inserted Cycle', cycle.cycleRecord.counter, cycle.cycleMarker)
  } catch (e) {
    Logger.mainLogger.error(e)
    Logger.mainLogger.error(
      'Unable to insert cycle or it is already stored in to database',
      cycle.cycleRecord.counter,
      cycle.cycleMarker
    )
  }
}

export async function bulkInsertCycles(cycles: Cycle[]): Promise<void> {
  try {
    const fields = Object.keys(cycles[0]).join(', ')
    const placeholders = Object.keys(cycles[0]).fill('?').join(', ')
    const values = extractValuesFromArray(cycles)
    let sql = 'INSERT OR REPLACE INTO cycles (' + fields + ') VALUES (' + placeholders + ')'
    for (let i = 1; i < cycles.length; i++) {
      sql = sql + ', (' + placeholders + ')'
    }
    await db.run(sql, values)
    Logger.mainLogger.debug('Successfully inserted Cycles', cycles.length)
  } catch (e) {
    Logger.mainLogger.error(e)
    Logger.mainLogger.error('Unable to bulk insert Cycles', cycles.length)
  }
}

export async function updateCycle(marker: string, cycle: Cycle): Promise<void> {
  try {
    const sql = `UPDATE cycles SET counter = $counter, cycleRecord = $cycleRecord WHERE cycleMarker = $marker `
    await db.run(sql, {
      $counter: cycle.counter,
      $cycleRecord: cycle.cycleRecord && SerializeToJsonString(cycle.cycleRecord),
      $marker: marker,
    })
    if (config.VERBOSE) {
      Logger.mainLogger.debug('Updated cycle for counter', cycle.cycleRecord.counter, cycle.cycleMarker)
    }
  } catch (e) {
    Logger.mainLogger.error(e)
    Logger.mainLogger.error('Unable to update Cycle', cycle.cycleMarker)
  }
}

export async function queryCycleByMarker(marker: string): Promise<Cycle> {
  try {
    const sql = `SELECT * FROM cycles WHERE cycleMarker=? LIMIT 1`
    const dbCycle = (await db.get(sql, [marker])) as DbCycle
    let cycle: Cycle
    if (dbCycle) {
      if (dbCycle.counter) cycle.counter = dbCycle.counter
      if (dbCycle.cycleRecord) cycle.cycleRecord = DeSerializeFromJsonString(dbCycle.cycleRecord)
      if (dbCycle.cycleMarker) cycle.cycleMarker = DeSerializeFromJsonString(dbCycle.cycleMarker)
    }
    if (config.VERBOSE) {
      Logger.mainLogger.debug('cycle marker', cycle)
    }
    return cycle
  } catch (e) {
    Logger.mainLogger.error(e)
    return null
  }
}

export async function queryLatestCycleRecords(count: number): Promise<CyclesCycle[]> {
  try {
    const sql = `SELECT * FROM cycles ORDER BY counter DESC LIMIT ${count ? count : 100}`
    const cycles = (await db.all(sql)) as DbCycle[]
    const cycleRecords: CyclesCycle[] = []
    if (cycles.length > 0) {
      for (let i  = 0; i < cycles.length; i++) {
        /* eslint-disable security/detect-object-injection */
        let tempCycleRecord: CyclesCycle
        if (cycles[i].cycleRecord) tempCycleRecord = DeSerializeFromJsonString(cycles[i].cycleRecord) as CyclesCycle
        if (cycles[i].cycleMarker) tempCycleRecord.marker = cycles[i].cycleMarker
        cycleRecords.push(tempCycleRecord)
        /* eslint-enable security/detect-object-injection */
      }
    }
    if (config.VERBOSE) {
      Logger.mainLogger.debug('cycle latest', cycleRecords)
    }
    return cycleRecords
  } catch (e) {
    Logger.mainLogger.error(e)
    return null
  }
}

export async function queryCycleRecordsBetween(start: number, end: number): Promise<CycleRecord[]> {
  try {
    const sql = `SELECT * FROM cycles WHERE counter BETWEEN ? AND ? ORDER BY counter ASC`
    const cycles = (await db.all(sql, [start, end])) as DbCycle[]
    const cycleRecords: P2P.CycleCreatorTypes.CycleRecord[] = []
    if (cycles.length > 0) {
      for (let i  = 0; i < cycles.length; i++) {
        // eslint-disable-next-line security/detect-object-injection
        if (cycles[i].cycleRecord) cycleRecords.push(DeSerializeFromJsonString(cycles[i].cycleRecord))
      }
    }
    if (config.VERBOSE) {
      Logger.mainLogger.debug('cycle between', cycleRecords)
    }
    return cycleRecords
  } catch (e) {
    Logger.mainLogger.error(e)
    return null
  }
}

export async function queryCyleCount(): Promise<number> {
  let cycles
  try {
    const sql = `SELECT COUNT(*) FROM cycles`
    cycles = await db.get(sql, [])
  } catch (e) {
    Logger.mainLogger.error(e)
  }
  if (config.VERBOSE) {
    Logger.mainLogger.debug('Cycle count', cycles)
  }
  if (cycles) cycles = cycles['COUNT(*)']
  else cycles = 0
  return cycles
}
