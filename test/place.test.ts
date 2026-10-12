import { describe, expect, test } from 'bun:test'

import { placeKey, readPlaceKey, sortedParts } from '../place.ts'

/**
 * The key a session is filed under. These strings are written into people's
 * projects, so what this file pins is a contract: a change that makes any of
 * them spell differently is a change that loses somebody their sessions.
 */
describe('the key of a place', () => {
  test('is readable, and spells every part of the place', () => {
    expect(placeKey({ epic: 'thesis', parts: ['methods', 'results'], kehikko: 3 })).toBe('epic=thesis;parts=methods+results;kehikko=3')
  })

  test('the parts are a set: the order they were picked in does not matter', () => {
    const one = placeKey({ epic: 'thesis', parts: ['results', 'methods'], kehikko: 3 })
    const other = placeKey({ epic: 'thesis', parts: ['methods', 'results'], kehikko: 3 })
    expect(one).toBe(other)
    expect(sortedParts(['b', 'a', 'b'])).toEqual(['a', 'b'])
  })

  test('Methods alone and Methods with Results are different places, and nothing picked is a place too', () => {
    const keys = [
      placeKey({ epic: 'thesis', parts: [], kehikko: 3 }),
      placeKey({ epic: 'thesis', parts: ['methods'], kehikko: 3 }),
      placeKey({ epic: 'thesis', parts: ['methods', 'results'], kehikko: 3 }),
    ]
    expect(new Set(keys).size).toBe(3)
    expect(keys[0]).toBe('epic=thesis;parts=-;kehikko=3')
  })

  test('another epic and another kehikko are other places', () => {
    const here = placeKey({ epic: 'thesis', parts: ['methods'], kehikko: 3 })
    expect(placeKey({ epic: 'paper-two', parts: ['methods'], kehikko: 3 })).not.toBe(here)
    expect(placeKey({ epic: 'thesis', parts: ['methods'], kehikko: 4 })).not.toBe(here)
  })

  test('no epic and no kehikko are spelled, not left out', () => {
    expect(placeKey({ epic: null, parts: [], kehikko: null })).toBe('epic=-;parts=-;kehikko=-')
  })

  test('holds ids only, so renaming a part or a kehikko moves nothing', () => {
    /* A heading and a kehikko's name never reach the key: the same ids are the same place whatever they are called today. */
    const key = placeKey({ epic: 'thesis', parts: ['methods'], kehikko: 3 })
    expect(key).not.toContain('Methods')
    expect(key).not.toContain('writing')
  })

  test('reads back to the place it was made from', () => {
    for (const place of [
      { epic: 'thesis', parts: ['methods', 'results'], kehikko: 3 },
      { epic: null, parts: [], kehikko: null },
      { epic: 'a-b-c', parts: ['part-1'], kehikko: 0 },
    ]) {
      expect(readPlaceKey(placeKey(place))).toEqual(place)
    }
  })

  test('refuses anything it would not have written', () => {
    for (const not of [
      '',
      'constructor',
      '__proto__',
      'epic=thesis',
      'epic=thesis;parts=b+a;kehikko=3',
      'epic=thesis;parts=a+a;kehikko=3',
      'epic=Thesis;parts=-;kehikko=3',
      'epic=thesis;parts=-;kehikko=three',
      'epic=../x;parts=-;kehikko=3',
      'epic=thesis;parts=-;kehikko=3;extra=1',
    ]) {
      expect(readPlaceKey(not)).toBeNull()
    }
  })
})
