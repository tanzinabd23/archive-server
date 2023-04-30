import { stringify } from './stringify'
import { config } from '../Config'

export function SerializeToJsonString(obj: any): string {
  if (config.useSerialization) return stringify(obj, { bufferEncoding: 'base64' })
  else return JSON.stringify(obj)
}

export function DeSerializeFromJsonString<T>(jsonString: string): T {
  if (config.useSerialization) return <T>JSON.parse(jsonString, base64BufferReviver)
  else return JSON.parse(jsonString)
}

function base64BufferReviver(key: string, value: any) {
  const originalObject = value
  if (
    isObject(originalObject) &&
    originalObject.hasOwnProperty('dataType') &&
    originalObject.dataType &&
    originalObject.dataType == 'bh'
  ) {
    return GetBufferFromField(originalObject, 'base64')
  } else {
    return value
  }
}

export const isObject = (val) => {
  if (val === null) {
    return false
  }
  if (Array.isArray(val)) {
    return false
  }
  return typeof val === 'function' || typeof val === 'object'
}

export function GetBufferFromField(input: any, encoding?: 'base64' | 'hex'): Buffer {
  switch (encoding) {
    case 'base64':
      return Buffer.from(input.data, 'base64')
    default:
      return Buffer.from(input)
  }
}
