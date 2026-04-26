# DCP (Distributed Compute Platform) - Complete LLM Reference

## Overview

DCP is a distributed computing platform that allows you to distribute computational jobs across a network of workers. Workers earn DCC (DCP Credits) for completing work, and job deployers spend DCC to have their computation performed.

**Core Concept**: You define input data and a work function, DCP distributes slices of work to remote workers, workers execute your function on your data, and results are returned to you.

---

## Quick Start

### Installation
```bash
npm i dcp-client
```

### Minimal Node.js Example
```javascript
const { init } = require('dcp-client');
const compute = require('dcp/compute');

async function main() {
  await init('https://scheduler.distributed.computer');
  
  const inputSet = [1, 2, 3, 4, 5];
  
  async function workFunction(datum) {
    progress(); // REQUIRED - heartbeat for the job
    return datum * datum;
  }
  
  const job = compute.for(inputSet, workFunction);
  job.on('accepted', () => console.log(`Job id: ${job.id}`));
  
  const results = await job.exec();
  console.log(Array.from(results));
}

require('dcp-client').init().then(main);
```

### Browser Example
```html
<script src="https://scheduler.distributed.computer/dcp-client/dcp-client.js"></script>
<script>
async function main() {
  const compute = dcp.compute;
  const inputSet = [1, 2, 3, 4, 5];
  
  async function workFunction(input, arg1, arg2) {
    progress();
    return input * arg1 * arg2;
  }
  
  const job = compute.for(inputSet, workFunction, [25, 11]);
  const results = await job.exec();
  console.log(results);
}
</script>
<button onclick="main()">Deploy Job</button>
```

---

## Keystores

DCP uses two types of keystores:

### Identity Keystore (`id.keystore`)
- Acts as your personal credentials on DCP
- Generated via: `mkad new id` (use empty password)
- Stored at: `~/.dcp/id.keystore`

### Account Keystore (`default.keystore`)
- Tracks your DCC balance (credits)
- Download from DCP Portal: https://portal.distributed.computer
- Stored at: `~/.dcp/default.keystore`

### Generating Keystores (CLI)
```bash
mkdir ~/.dcp
npm install --global dcp-util
mkad new id           # recommended: use empty password
mkad new default      # choose a password you won't forget
ls ~/.dcp
```

### Wallet API
```javascript
const wallet = require('dcp/wallet');

// Load keystore from disk
const keystore = await wallet.load('default');

// Get default keystore
const account = await wallet.get();

// Get identity keystore
const identity = await wallet.getId();

// Add a keystore to the wallet cache
await wallet.add(keystore, 'myAccount');

// Unlock a keystore for operations
await keystore.unlock(passphrase, durationInSeconds);

// Lock a keystore
keystore.lock();

// Get the private key (unlocks if needed)
const privateKey = await keystore.getPrivateKey();
```

---

## Compute API (`dcp/compute`)

### Core Functions

#### `compute.do(n, work, arguments)`
Run a work function `n` times.

```javascript
// Run work 5 times, return array of results
const job = compute.do(5, workFunction);
const results = await job.exec();
```

#### `compute.for(range, work, arguments)`
Distribute work across an input set.

```javascript
// Form 1: Range object
const job = compute.for({ start: 0, end: 100, step: 1 }, workFunction);

// Form 2: Start, stop, step
const job = compute.for(0, 100, 1, workFunction);

// Form 3: Start, stop (step defaults to 1)
const job = compute.for(0, 100, workFunction);

// Form 4: Multi-dimensional (nested loops)
const job = compute.for({ ranges: [{ start: 0, end: 3 }, { start: 0, end: 3 }], workFunction);

// Form 5: Iterable (Array, Generator)
const job = compute.for([1, 2, 3, 4, 5], workFunction);
```

#### `compute.status(job)`
Query job status.

```javascript
const status = await compute.status(job);
// Returns: { runStatus, total, distributed, computed }
```

#### `compute.getJobInfo(jobId)`
Get detailed job information.

```javascript
const info = await compute.getJobInfo(jobId);
```

#### `compute.getSliceInfo(jobId)`
Get slice status and history.

```javascript
const sliceInfo = await compute.getSliceInfo(jobId);
```

#### `compute.cancel(jobId)`
Cancel a running job.

```javascript
await compute.cancel(job.id);
```

#### `compute.marketRate(factor)`
Get dynamic market rate for job payment.

```javascript
const rate = compute.marketRate(1.0); // 1.0 = market rate multiplier
```

#### `compute.getMarketValue()`
Get a signed work value quote for cost control.

```javascript
const quote = await compute.getMarketValue();
// Contains: CPUHour, GPUHour, InputMByte, OutputMByte, quoteExpiry, signature
```

#### `compute.calculateSlicePayment(sliceProfile, workValue)`
Calculate payment for a slice.

```javascript
const payment = compute.calculateSlicePayment(sliceProfile, workValue);
```

---

## Job Handle (Return from `compute.for` / `compute.do`)

### Properties

```javascript
job.id                  // Unique job ID from scheduler
job.receipt            // Cryptographic deployment receipt
job.status             // { runStatus, total, distributed, computed }
job.results            // ResultHandle for accessing outputs
job.meanSliceProfile   // Average costs (available after first result)
job.paymentAccount     // Keystore being used for payment
job.requirements       // Worker requirements object
job.initialSliceProfile // Cost estimates for scheduling
job.slicePaymentOffer  // Payment offer per slice
job.public             // { name, description, link } for job labeling
job.scheduler          // Scheduler URL
job.bank               // Bank URL
job.collateResults     // If false, results not auto-returned
```

### Methods

```javascript
// Execute the job
const results = await job.exec(slicePaymentOffer, paymentAccount, initialSliceProfile);

// Cancel the job
await job.cancel();

// Resume a paused job
await job.resume();

// Execute locally (no network)
const localResults = await job.localExec(cores);

// Add module dependency
job.require('./myModule');
job.require(['module1', 'module2']);

// Get resource estimate for one slice
const profile = await job.estimate(sampleDatum);

// Set payment offer
job.setSlicePaymentOffer(0.00015);

// Set payment account
job.setPaymentAccountKeystore(keystore);
```

### Events

```javascript
job.on('accepted', (data) => { /* job deployed */ });
job.on('result', (data) => { /* single result: data.address, data.task, data.sort, data.result */ });
job.on('resultsUpdated', () => { /* result handle modified */ });
job.on('complete', (resultHandle) => { /* all done */ });
job.on('status', (data) => { /* status update: data.total, data.distributed, data.computed */ });
job.on('error', (data) => { /* slice error: data.sliceIndex, data.message, data.stack */ });
job.on('console', (data) => { /* from work: data.level, data.message, data.sliceIndex */ });
job.on('noProgress', (data) => { /* slice stopped: data.sliceIndex, data.timestamp */ });
job.on('cancel', () => { /* job cancelled */ });
```

---

## Result Handle

Returned via `job.results` after execution.

```javascript
// Array-like access
results[0]              // Get result by index
results.keys(n)         // Get nth input key
results.values()        // All output values
results.entries()       // [[input, output], ...]
results.fromEntries()   // Object mapping inputs to outputs
results.lookupValue(input) // Get result for specific input

// Scheduler storage methods
await results.fetch(rangeObject, emitEvents);  // Fetch results from scheduler
await results.delete(rangeObject);             // Delete results from scheduler
const stats = await results.stat(rangeObject); // Get slice statistics
const list = await results.list(rangeObject); // Get list of computed slices
```

---

## Work Function (runs on remote workers)

```javascript
async function workFunction(input, ...args) {
  // REQUIRED: Call progress() to signal you're alive
  progress();
  
  // Your computation
  const result = doSomethingWith(input);
  
  // Return result (must be JSON-serializable)
  return result;
}
```

### Worker Environment Globals

```javascript
progress(n)              // Report progress (0-1), or undefined for indeterminate
console.log/debug/info/warn/error()  // Emit events on job handle
work.emit(eventName, data)          // Custom events to client
work.job.public                  // Job's public data { name, description, link }
```

### Important Constraints
- Work function is serialized via `.toString()` - cannot close over local variables
- All data needed must be passed via the `arguments` parameter
- Must call `progress()` at least once (every ~30 seconds)
- Results must be JSON-serializable

---

## Range Objects

```javascript
// Basic range
{ start: 0, end: 100, step: 1, group: 1 }

// Sparse (non-contiguous)
{ sparse: [{ start: 0, end: 10 }, { start: 50, end: 60 }] }

// Multi-dimensional
{ ranges: [{ start: 0, end: 3 }, { start: 0, end: 3 }] }
```

### Grouping (multiple inputs per slice)
```javascript
{ start: 0, end: 100, group: 10 }
// Work function receives array of 10 elements per slice
function workFunction(inputs) {
  return inputs.map(x => x * x);
}
```

---

## Distribution Objects (Statistics)

```javascript
const stats = require('stats');

// Normal distribution
const normalSet = stats.set.normalRNG(100, 50, 0.5);

// Random set
const randomSet = stats.set.random(100, 0, 100);

// Random integers
const intSet = stats.set.randomInt(100, 0, 100);

const job = compute.for(normalSet, workFunction);
```

---

## Requirements Object (Worker Filtering)

```javascript
job.requirements = {
  environment: {
    fdlibm: true,              // Bitwise-identical math library
    offscreenCanvas: true      // WebGL canvas support
  },
  engine: {
    es2019: true,              // ES2019 support required
    spidermonkey: false        // Must NOT be SpiderMonkey
  },
  gpu: true                    // Requires GPU support
};
```

### GPU Support
```javascript
// Enable GPU via WebGL
job.requirements = {
  gpu: true,
  environment: { offscreenCanvas: true }
};
```

---

## Job Payment &escrow

### Payment Flow
1. Job deployed → deployment fee charged
2. For uncharacterized work: small escrow for estimation phase
3. During execution: funds escrowed as slices complete
4. Job complete → excess escrow returned

### Payment Account Setup
```javascript
// Via wallet
const wallet = require('dcp/wallet');
const account = await wallet.get();

// Set on job
job.setPaymentAccountKeystore(account);

// Or via exec
const results = await job.exec(payment, account);
```

### ENOFUNDS Handling
```javascript
job.on('error', (err) => {
  if (err.message.includes('ENOFUNDS')) {
    // Add funds to your account keystore
    // Then resume:
    await job.resume();
  }
});
```

---

## Worker API (for earning DCC)

```javascript
const { Worker } = require('dcp/worker');

const worker = new Worker({
  paymentAddress: '0x...',      // Where DCC is deposited
  identityKeystore: idKeystore, // Identity for communication
  schedulerURL: 'https://scheduler.distributed.computer',
  maxWorkingSandboxes: 2,      // Parallel slices
  minimumWage: {                // Minimum acceptable rates
    CPU: 0.0001,               // DCC per second
    GPU: 0.001,
    input: 0.00001,            // DCC per byte
    output: 0.00001
  }
});

// Events
worker.on('start', () => {});
worker.on('stop', () => {});
worker.on('sandbox', (sandbox) => {});
worker.on('payment', (data) => { /* data.accepted, data.payment, data.reason */ });
worker.on('fetch', () => {});
worker.on('submit', () => {});
worker.on('fetchError', (err) => {});
worker.on('submitError', (err) => {});

// Sandbox events
worker.on('sliceStart', (data) => {});
worker.on('sliceFinish', (data) => {});
worker.on('sliceError', (data, err) => {});
worker.on('sliceEnd', (data) => {});
worker.on('terminate', () => {});

// Start/stop
await worker.start();
await worker.stop(true); // immediate stop

// Prevent worker from starting (persists)
Worker.disableWorker();
```

---

## Address & Key Management

```javascript
const wallet = require('dcp/wallet');

// Create address from string
const addr = new wallet.Address('0x1234...');

// Compare addresses
addr.eq(otherAddr);        // true/false
addr.ct(privateKey);       // Check if matches private key

// Verify signature
addr.verifySignature(messageBody, signature);

// Create from private key
const pKey = new wallet.PrivateKey('0xabcd...');
const addr2 = new wallet.Address(pKey);

// Keystore operations
const ks = new wallet.Keystore();                    // Random new key
const ks2 = new wallet.Keystore(privateKey);         // From private key
const ks3 = new wallet.Keystore(privateKey, 'pass'); // Encrypted
const ks4 = new wallet.Keystore(jsonString);         // From UTC/JSON format

// Sign messages
const signedMsg = ks.makeSignedMessage(messageBody);
const sig = ks.makeSignature(messageBody);

// JSON export/import
const json = ks.toJSON();
```

---

## Protocol API (Low-Level Messaging)

```javascript
const protocol = require('dcp/protocol');

// Create connection
const conn = new protocol.Connection({
  url: 'wss://scheduler.distributed.computer',
  idKeystore: identityKeystore,
  connectionOptions: {
    allowBatch: true,
    maxMessagesPerBatch: 10,
    ttl: { default: 300, min: 60, max: 3600 }
  }
});

// Connection events
conn.on('request', (req) => { /* handle request */ });
conn.on('readyStateChange', (state) => {});
conn.on('send', (msg, ethMsg) => {});
conn.on('close', () => {});

// States: 'initial' | 'established' | 'waiting' | 'close-wait' | 'closing' | 'closed'

// Send request
const response = await conn.send({
  operation: 'myOperation',
  data: { /* payload */ }
});

// Request with authorization
const req = new conn.Request('escrow', { amount: 100 });
req.authorize(resourceKeystore, guardianAddress, accessorAddress);
const response = await req.send();

// Convenience: conn.Request.send(operation, data, ks)
const resp = await conn.Request.send('withdraw', { amount: 5 }, myKeystore);

// Handle incoming requests
conn.on('request', (req) => {
  // Authorize for specific resource
  const isAuth = req.doesAuthorize(resourceAddress, guardian, accessor, validateSig);
  
  // Respond
  req.respond(data);         // success
  req.respond(errorPayload); // failure
});

// Batch messages
const batch = new conn.Batch();
batch.add(request1);
batch.add(request2);
await batch.send();
```

---

## CommonJS Modules in Work Functions

```javascript
// In your main code
const job = compute.for(inputSet, workFunction);

// Deploy local modules
job.require('./myModule');
job.require('some-npm-package');

// Module must exist in work function's scope
// In work function:
const myModule = require('myModule');
const result = myModule.doSomething(input);
```

---

## Data URI (Remote Input Data)

```javascript
// Use remote data instead of local array
const dataUri = 'https://example.com/large-dataset.json';

const job = compute.for(dataUri, workFunction);
```

---

## Error Codes

| Code | Meaning |
|------|---------|
| ENOFUNDS | Insufficient credits in payment account |
| ENOPROGRESS | Worker not receiving progress updates |
| ETOOMANYTASKS | Job exceeds maximum task limit |
| EWORKTOOBIG | Work function + modules too large |
| ETOOBIG | Job exceeds maximum allowable work |
| ESLICETOOSLOW | Slice exceeded max execution time |
| ETOOMANYERRORS | Too many slices threw errors |

---

## Environment Setup Summary

### Node.js
```bash
npm i dcp-client
mkdir ~/.dcp
mkad new id       # identity keystore
mkad new default  # account keystore (download from portal)
```

### Browser
```html
<script src="https://scheduler.distributed.computer/dcp-client/dcp-client.js"></script>
```

### Worker (Earning DCC)
```bash
npm i -g dcp-client
dcp-worker
# Or use Worker API programmatically
```

---

## DCP Network Endpoints

| Service | URL |
|---------|-----|
| Scheduler | `https://scheduler.distributed.computer` |
| Portal | `https://dcp.cloud` |
| Bank | Configured per deployment |

---

## Quick Reference: Typical Job Pattern

```javascript
const { init } = require('dcp-client');
const compute = require('dcp/compute');
const wallet = require('dcp/wallet');

async function main() {
  await init('https://scheduler.distributed.computer');
  
  // Optional: explicitly set payment account
  const account = await wallet.get();
  
  const inputSet = /* your input data */;
  
  async function workFunction(input, ...args) {
    progress();
    // Your computation
    return result;
  }
  
  const job = compute.for(inputSet, workFunction, [arg1, arg2]);
  
  job.public = {
    name: 'My Job',
    description: 'What this does',
    link: 'https://example.com/info'
  };
  
  // Optional: set payment
  // job.setPaymentAccountKeystore(account);
  // job.setSlicePaymentOffer(0.00015);
  
  job.on('accepted', () => console.log('Deployed:', job.id));
  job.on('error', (e) => console.error('Error:', e));
  
  const results = await job.exec();
  console.log('Results:', Array.from(results));
}

require('dcp-client').init().then(main);
```

---

## Key Things to Remember

1. **Always call `progress()`** in work functions - or the job will be killed
2. **Cannot close over variables** - pass all data via the `arguments` parameter to `compute.for`
3. **Results must be JSON-serializable** - no circular references, no native objects
4. **Funds are escrowed** - job execution costs DCC, ensure you have sufficient balance
5. **Work is distributed as source** - `Function.toString()` is used, so no dynamic code generation in work functions
6. **Identity vs Account keystores** - identity is for authentication, account is for payment
