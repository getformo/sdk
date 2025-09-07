import { expect } from 'chai';
import { IPV4_PATTERN, IPV6_PATTERN } from '../../src/constants';

/**
 * Test suite for IPv6 address detection bug fix
 * 
 * This tests the regex patterns used to detect IPv6 addresses
 * to ensure that cookie deletion doesn't attempt parent domain 
 * operations on IP addresses (which is invalid).
 */
describe('IPv6 Address Detection', () => {
  // Helper function that mimics the isIPAddress method logic from FormoAnalytics
  function isIPAddress(hostname: string): boolean {
    return IPV4_PATTERN.test(hostname) || IPV6_PATTERN.test(hostname);
  }

  describe('IPv4 Address Detection', () => {
    it('should detect valid IPv4 addresses', () => {
      const validIPv4Addresses = [
        '192.168.1.1',
        '127.0.0.1',
        '10.0.0.1',
        '172.16.0.1',
        '255.255.255.255',
        '0.0.0.0'
      ];

      validIPv4Addresses.forEach(ip => {
        expect(isIPAddress(ip)).to.be.true;
      });
    });

    it('should reject invalid IPv4 addresses', () => {
      const invalidIPv4Addresses = [
        '256.1.1.1',
        '192.168.1',
        '192.168.1.1.1',
        'example.com',
        'localhost'
      ];

      invalidIPv4Addresses.forEach(ip => {
        expect(isIPAddress(ip)).to.be.false;
      });
    });
  });

  describe('IPv6 Address Detection', () => {
    it('should detect valid IPv6 addresses with hexadecimal characters', () => {
      const validIPv6Addresses = [
        '2001:0db8:85a3:0000:0000:8a2e:0370:7334', // Full IPv6
        '2001:db8:85a3:0:0:8a2e:370:7334',         // Compressed zeros
        '2001:db8:85a3::8a2e:370:7334',            // Double colon compression
        '::1',                                      // Loopback
        '::',                                       // All zeros
        'fe80::1',                                  // Link-local
        '2001:db8::1',                             // Mixed compression
        'ff02::1',                                 // Multicast
        '2001:0db8:0000:0000:0000:ff00:0042:8329', // Full form with mixed case
        '2001:DB8:0:0:1:0:0:1'                     // Upper case hex
      ];

      validIPv6Addresses.forEach(ip => {
        expect(isIPAddress(ip), `Failed to detect IPv6 address: ${ip}`).to.be.true;
      });
    });

    it('should reject invalid IPv6 addresses', () => {
      const invalidIPv6Addresses = [
        '2001:0db8:85a3::8a2e::7334',  // Multiple double colons
        '2001:0db8:85a3:0000:0000:8a2e:0370:7334:extra', // Too many groups
        'gggg::1',                     // Invalid hex characters
        'example.com',                 // Domain name
        'localhost',                   // Hostname
      ];

      invalidIPv6Addresses.forEach(ip => {
        expect(isIPAddress(ip), `Incorrectly detected as IP address: ${ip}`).to.be.false;
      });
    });

    it('should handle edge cases correctly', () => {
      // The original bug: these should be detected as IPv6 addresses
      const hexContainingIPv6 = [
        '2001:db8:abcd:ef01::1',       // Contains a-f characters
        'fe80::abcd:ef01:2345:6789',   // Link-local with hex
        '2001:DB8:ABCD:EF01::1'        // Upper case hex
      ];

      hexContainingIPv6.forEach(ip => {
        expect(isIPAddress(ip), `Failed to detect IPv6 with hex chars: ${ip}`).to.be.true;
      });
    });
  });

  describe('Domain Name Detection', () => {
    it('should not detect domain names as IP addresses', () => {
      const domainNames = [
        'example.com',
        'subdomain.example.com',
        'localhost',
        'my-app.localhost',
        'app.test',
        'api.staging.example.org'
      ];

      domainNames.forEach(domain => {
        expect(isIPAddress(domain), `Incorrectly detected domain as IP: ${domain}`).to.be.false;
      });
    });
  });
});
