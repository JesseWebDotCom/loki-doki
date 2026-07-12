import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import { isSameMachine, normalizeIp } from './clientMachine'

describe('normalizeIp', () => {
  test('strips IPv4-mapped prefix', () => {
    expect(normalizeIp('::ffff:192.168.1.10')).toBe('192.168.1.10')
  })
  test('folds loopback spellings', () => {
    expect(normalizeIp('::1')).toBe('loopback')
    expect(normalizeIp('127.0.0.1')).toBe('loopback')
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('loopback')
    expect(normalizeIp('127.1.2.3')).toBe('loopback')
  })
  test('handles empty/undefined', () => {
    expect(normalizeIp(undefined)).toBe('unknown')
    expect(normalizeIp('')).toBe('unknown')
  })
  test('lowercases IPv6', () => {
    expect(normalizeIp('FE80::ABCD')).toBe('fe80::abcd')
  })
})

describe('isSameMachine', () => {
  test('equal IPs match', () => {
    expect(isSameMachine('192.168.1.10', '::ffff:192.168.1.10')).toBe(true)
  })
  test('different IPs do not match', () => {
    expect(isSameMachine('192.168.1.10', '192.168.1.11')).toBe(false)
  })
  test('unknown never matches', () => {
    expect(isSameMachine('unknown', 'unknown')).toBe(false)
    expect(isSameMachine('192.168.1.10', 'unknown')).toBe(false)
  })
  test('both loopback match', () => {
    expect(isSameMachine('127.0.0.1', '::1')).toBe(true)
  })
  test('loopback matches a real server interface address', () => {
    // Any non-internal interface address of the machine running this test counts as
    // "the server itself" — the dock-via-localhost + browser-via-LAN-IP case.
    const iface = Object.values(os.networkInterfaces()).flat()
      .find((i) => i && !i.internal)
    if (!iface) return // no external interface on this runner; nothing to assert
    expect(isSameMachine('127.0.0.1', iface.address)).toBe(true)
    expect(isSameMachine(iface.address, '::1')).toBe(true)
  })
  test('loopback does not match a foreign address', () => {
    expect(isSameMachine('127.0.0.1', '203.0.113.9')).toBe(false)
  })
})
