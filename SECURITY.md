# Security Policy

## Supported Versions

Tide is currently under active development and has not yet reached its first stable release.

Until the first stable release, security fixes will generally be applied only to the latest development version.

| Version                    | Supported      |
| -------------------------- | -------------- |
| Latest development version | ✅              |
| Older development versions | ⚠️ Best effort |
| Unreleased versions        | ❌              |

Once stable releases exist, this table will be updated to document the supported versions and security-maintenance policy.

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in Tide, please report it privately so that it can be investigated and fixed before public disclosure.

### Preferred reporting method

Use GitHub's **Private Vulnerability Reporting** feature if it is enabled for this repository.

Alternatively, contact the project maintainer privately using the contact method listed in the repository's GitHub security settings.

When reporting a vulnerability, please provide as much of the following information as possible:

* A clear description of the vulnerability
* The affected Tide version or commit
* Affected platform(s)
* Steps required to reproduce the issue
* Expected behavior
* Actual behavior
* Security impact
* Proof of concept, if available
* Logs or screenshots where useful
* Any suggested mitigation, if known

Please avoid including real personal or calendar data in vulnerability reports.

Use synthetic test data whenever possible.

---

## What Should Be Reported?

Examples of security issues include:

* Unauthorized access to calendar data
* Authentication bypass
* Device-pairing vulnerabilities
* Synchronization authorization bypass
* Remote code execution
* Local privilege escalation
* Sensitive data disclosure
* Cryptographic implementation vulnerabilities
* Improper certificate or key validation
* Replay attacks
* Authentication token/key leakage
* Database corruption caused by malicious input
* Denial-of-service vulnerabilities
* Malicious ICS files causing application crashes or resource exhaustion
* Vulnerabilities allowing an unpaired device to access a calendar
* Vulnerabilities allowing a revoked device to continue synchronizing

If you are unsure whether an issue is security-sensitive, please report it privately.

---

## Response Process

When a vulnerability is reported, the maintainer will attempt to:

1. Acknowledge receipt of the report.
2. Reproduce and validate the issue.
3. Determine its security impact and severity.
4. Identify affected versions.
5. Develop and test a fix.
6. Prepare a security advisory where appropriate.
7. Release the fix.
8. Coordinate disclosure with the reporter where practical.

Response times may vary while the project is under development.

---

## Coordinated Disclosure

Tide follows a coordinated disclosure approach.

Please allow reasonable time for a vulnerability to be investigated and fixed before publicly disclosing technical details.

The appropriate disclosure timeline depends on:

* Severity
* Exploitability
* Number of affected users
* Availability of a workaround
* Complexity of the required fix
* Whether a fix can be safely released

For actively exploited vulnerabilities or vulnerabilities with significant public exposure, the project may prioritize an accelerated response.

---

## CVEs and Security Advisories

When appropriate, security vulnerabilities may receive a **CVE identifier**.

GitHub Security Advisories may be used to coordinate vulnerability disclosure and provide affected users with information about:

* Affected versions
* Fixed versions
* Severity
* Impact
* Mitigations
* Workarounds
* References

Not every security issue will necessarily receive a CVE.

CVE assignment depends on the nature and impact of the vulnerability and the availability of an appropriate CNA or other assignment mechanism.

---

## Severity

Security issues will be evaluated based on factors including:

* Attack complexity
* Required privileges
* User interaction
* Network accessibility
* Confidentiality impact
* Integrity impact
* Availability impact
* Scope of impact

Where appropriate, Tide will use **CVSS** as part of severity assessment.

Severity assigned by the project may differ from a researcher's initial assessment.

---

## Security Updates

Security fixes will be documented in the project's release notes and/or GitHub Security Advisories where appropriate.

Users should keep Tide updated to the latest supported release.

Security fixes may occasionally require database migrations or other compatibility changes.

Such changes will be documented with the release.

---

## Dependency Vulnerabilities

Tide relies on third-party libraries and platform components.

Security issues in dependencies may affect Tide even when the vulnerability is not present in Tide's own source code.

Relevant dependency vulnerabilities will be evaluated based on:

* Whether the vulnerable component is actually used
* Whether the vulnerable functionality is reachable
* Platform applicability
* Exploitability in Tide's architecture
* Availability of an upstream fix

Dependency updates will be tested before release.

---

## Scope

The security policy applies primarily to:

* Tide source code
* Tide synchronization protocol
* Tide device pairing
* Tide networking
* Tide local data handling
* Tide ICS parsing/import
* Tide build and release artifacts

Third-party infrastructure outside the project's control is generally outside the scope of this policy.

---

## Out of Scope

The following are generally not considered security vulnerabilities unless they result in a meaningful security impact:

* Missing features
* UI/UX bugs
* Performance problems without security impact
* Bugs requiring an already fully compromised operating system
* Issues requiring physical access to an unlocked device
* The fact that exported `.ics` files contain calendar data
* Expected behavior documented by the application

If an issue has uncertain security implications, report it privately rather than assuming it is out of scope.

---

## Safe Harbor

Security research performed in good faith is welcome.

Researchers who:

* Avoid unnecessary access to other users' data
* Avoid intentionally degrading service availability
* Avoid destructive testing
* Do not publicly disclose vulnerabilities before reasonable coordinated disclosure
* Stop testing once sufficient evidence has been obtained

will be treated as acting in good faith.

This security policy does not grant permission to violate laws or third-party terms of service.

---

## Recognition

With the reporter's permission, security researchers who responsibly disclose valid vulnerabilities may be credited in the relevant security advisory or release notes.

Researchers may request to remain anonymous.

---

## Contact

Security reports should be submitted privately through:

**GitHub Security Advisories / Private Vulnerability Reporting**

Public GitHub issues should **not** be used for undisclosed security vulnerabilities.

---

## Policy Changes

This policy may be updated as Tide matures, including changes to:

* Supported versions
* Reporting channels
* Disclosure timelines
* Severity assessment
* Security-maintenance commitments
