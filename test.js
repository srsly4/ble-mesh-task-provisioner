const WebSocket = require('ws');
const dbus = require('dbus-next');
const prompts = require('prompts');
const randomBytes = require('random-bytes');
const Struct = require('struct');
const fs = require('fs');

// noinspection ES6UnusedImports
import regeneratorRuntime from "regenerator-runtime";

const {
  Interface, property, method, signal, DBusError,
  ACCESS_READ, ACCESS_WRITE, ACCESS_READWRITE
} = dbus.interface;

let unicastAddress = 0x0002;

let management;
let network;
let token;
let client;
let firstConfigured = true;
let taskId = 1;
let timeBeaconEnabled = true;
let localLogicRate = 0.0;

const provisioned = {};

const beaconMap = {};

let node;

const APP_PATH = '/com/sp/jsprov';
const elementPath = `${APP_PATH}/ele00`;
const devSendReceiveCallbacks = {};

const bindStruct = Struct()
  .word16Ube('opcode')
  .word16Ule('element_addr')
  .word16Ube('model_app_idx')
  .word16Ule('company_id')
  .word16Ule('model_id');

bindStruct.allocate();

const enqueueStruct = Struct()
  .word8('opcode')
  .word16Ule('vendor_id')
  .word16Ule('tid')
  .word8('func_code')
  .word64Ule('time');

enqueueStruct.allocate();

const execAckStruct = Struct()
    .word8('opcode')
    .word16Ule('vendor_id')
    .word16Ule('tid')
    .word8Ule('data_len')
    .word32Ule('adc');

execAckStruct.allocate();

const timeBeaconStruct = Struct()
  .word8('opcode')
  .word16Ule('vendor_id')
  .word16Ule('logic_time_high')
  .word32Ule('logic_time_low')
  .word16Ule('hardware_time');

timeBeaconStruct.allocate();

const timeBeaconRecvStruct = Struct()
  .word8('opcode')
  .word16Ule('vendor_id')
  .word16Ule('logic_time_high')
  .word32Ule('logic_time_low')
  .word16Ule('hardware_time');

timeBeaconRecvStruct.allocate();

const driftBeaconStruct = Struct()
  .word8('opcode')
  .word16Ule('vendor_id')
  .word32Sle('logic_rate')
  .word16Ule('hardware_time');

driftBeaconStruct.allocate();

const driftBeaconStructRecv = Struct()
  .word8('opcode')
  .word16Ule('vendor_id')
  .word32Sle('logic_rate')
  .word16Ule('hardware_time');

driftBeaconStructRecv.allocate();

const otaUpdateStruct = Struct()
  .word8('opcode')
  .word16Ule('vendor_id');

otaUpdateStruct.allocate();

const sendData = (id, data={}) => {
  if (!client) {
    console.warn('No client to send data');
    return;
  }
  try {
    client.send(JSON.stringify({
      id,
      ...data,
    }));
  } catch (e) {
    console.error('Could not send data to client', id, e);
  }
}

const sendLog = (log) => {
  sendData('log', {log});
}

function bufferToHex(buffer, length=16) {
  return [...new Uint8Array (buffer)]
    .map (b => b.toString(length).padStart (2, "0"))
    .join ("");
}

function toHexString(byteArray) {
  return Array.from(byteArray, function(byte) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2);
  }).join('')
}

const waitForDevReceive = (expectedCallback, timeout= 10000) => {
  return new Promise((resolve, reject) => {
    const callbackId = Math.round(Math.random() * 100000000);

    const timeoutId = setTimeout(() => {
      delete devSendReceiveCallbacks[callbackId];
      reject(new Error('Waiting for dev receive timeout...'));
    }, timeout);

    devSendReceiveCallbacks[callbackId] = (source, remote, net_index, data) => {
      if (expectedCallback(source, remote, net_index, data)) {
        clearTimeout(timeoutId);
        delete devSendReceiveCallbacks[callbackId];
        resolve();
      }
    };
  });
}

const devSendReceive = (address, data, expectedCallback, maxResend=5, timeout=5000) => {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const callbackId = Math.round(Math.random() * 100000000);

    const resendInterval = setInterval(() => {
      tries += 1;
      if (tries > maxResend) {
        clearInterval(resendInterval)
        delete devSendReceiveCallbacks[callbackId];
        return reject(new Error('Max number of resend attempts reached'));
      }
      console.warn('No expected answer, resend attempt #' + tries);
      executeSend()
        .catch(reject);
    }, timeout);


    const executeSend = () => {
      return node.DevKeySend(elementPath, address, true, 0, data);
    };

    devSendReceiveCallbacks[callbackId] = (source, remote, net_index, data) => {
      if (expectedCallback(source, remote, net_index, data)) {
        clearInterval(resendInterval);
        delete devSendReceiveCallbacks[callbackId];
        resolve();
      }
    };

    return executeSend()
      .catch(reject);
  });
};


const configureNode = async (uuid, address) => {
  console.log('Configuring node ' + address);
  const startDate = Date.now();

  //get composition data page 0
  // console.log('Sending composition data get request');
  // await devSendReceive(address, [0x80, 0x08, 0x00], (source, remote, net_index, data) => {
  //   return data[0] === 0x02 && data[1] === 0x00;
  // });


  console.log('Adding AppKey for ' + elementPath);
  await node.AddAppKey(elementPath, address, 0, 0, false);
  await waitForDevReceive((source, remote, net_index, data) => {
    return data[0] === 0x80 && data[1] === 0x03;
  });


  const bindStructProxy = bindStruct.fields;

  bindStructProxy.opcode = 0x803D;
  bindStructProxy.element_addr = address;
  bindStructProxy.model_app_idx = 0x0000;
  bindStructProxy.company_id = 0x02E5;
  bindStructProxy.model_id = 0x00A2;

  await devSendReceive(address, Array.from(bindStruct.buffer()), () => true);

  console.log('Bound AppKey0 to task vendor model');

  bindStructProxy.opcode = 0x803D;
  bindStructProxy.element_addr = address;
  bindStructProxy.model_app_idx = 0x0000;
  bindStructProxy.company_id = 0x02E5;
  bindStructProxy.model_id = 0x00A4;

  await devSendReceive(address, Array.from(bindStruct.buffer()), () => true);

  console.log('Bound AppKey0 to time sync vendor model');

  bindStructProxy.opcode = 0x803D;
  bindStructProxy.element_addr = address;
  bindStructProxy.model_app_idx = 0x0000;
  bindStructProxy.company_id = 0x02E5;
  bindStructProxy.model_id = 0x00A6;

  await devSendReceive(address, Array.from(bindStruct.buffer()), () => true);

  const endDate = Date.now();
  const provisionStartTime = provisioned[uuid].provisionStartTime;
  const rssi = provisioned[uuid].rssi;
  fs.appendFile('provision_times.csv',
    `${String(endDate - provisionStartTime)},${String(endDate - startDate)},${String(rssi)}\n`, (err) => {
    if (err)
      console.warn('Could not log provision time', err);
  })

  console.log('Bound AppKey0 to OTA vendor model');

  sendLog(`Node ${address} configured`);
  sendData('nodeAdded', {
    address,
    uuid,
  })

  // await node.Send(elementPath, address, 0, [0xc2, 0xE5, 0x02, 0xbb, 0x05]);
  // const enqueueStructProxy = enqueueStruct.fields;
  //
  // enqueueStructProxy.opcode = 0xc2;
  // enqueueStructProxy.vendor_id = 0x02e5;
  // enqueueStructProxy.func_code = 0xbb;
  // enqueueStructProxy.time = Date.now() + 10000;
  //
  // await node.Send(elementPath, address, 0, Array.from(enqueueStruct.buffer()));
  // console.log('Vendor task ENQUEUE sent');

  if (firstConfigured) {
    firstConfigured = false;
    console.log('Starting sending time beacons');

    const timeBeacon = timeBeaconStruct.fields;
    timeBeacon.opcode = 0xc5;
    timeBeacon.vendor_id = 0x02e5;

    const driftBeacon = driftBeaconStruct.fields;
    driftBeacon.opcode = 0xc6;
    driftBeacon.vendor_id = 0x02e5

    setInterval(() => {
      if (!timeBeaconEnabled) {
        return;
      }

      // update logic drift
      let logicDrift = localLogicRate;
      let neighbourCount = 0;

      Object.values(beaconMap).forEach((beacon) => {
        if (!beacon.read) {
          logicDrift += beacon.relativeLogicRate;
          neighbourCount += 1;
        }
      })

      localLogicRate = logicDrift / (neighbourCount + 1);

      const logic_time = BigInt(Date.now());
      const low = Number(logic_time & BigInt(0xFFFFFFFF));
      const high = Number(logic_time >> 32n);

      console.log('Broadcasting time ' + Number(logic_time), low, high);
      timeBeacon.logic_time_low = low;
      timeBeacon.logic_time_high = high;
      timeBeacon.hardware_time = Date.now() & 0xFFFF;

      node.Send(elementPath, 0xFFFF, 0, Array.from(timeBeaconStruct.buffer()));

      setTimeout(() => {
        console.log('Broadcasting drift ' + localLogicRate);
        driftBeacon.logic_rate = Math.round(localLogicRate * 2147483647.0);
        driftBeacon.hardware_time = Date.now() & 0xFFFF;

        node.Send(elementPath, 0xFFFF, 0, Array.from(driftBeaconStruct.buffer()));
      }, 1000);
    }, 5000);
  }
};

class RootInterface extends Interface {
  constructor(name, childrenObjects) {
    super(name);
    this.schema = childrenObjects;
  }

  @method({inSignature: '', outSignature: 'a{oa{sa{sv}}}'})
  GetManagedObjects() {
    console.log('Call to GetManagedObjects');
    const ret = Object.keys(this.schema).reduce((acc, childPath) => {
      const childObjects = this.schema[childPath];

      const child = childObjects.reduce((accInt, interf) => {
        accInt[interf.$name] = {};

        const properties = interf.__proto__.$properties || {};
        for (const propertyName of Object.keys(properties)) {
          accInt[interf.$name][propertyName] = new dbus.Variant(properties[propertyName].signature, interf[propertyName]);
        }

        return accInt;
      }, {});

      acc[childPath] = child;

      return acc;
    }, {});

    console.log('Returning', ret);
    return ret;
  }

  export(bus, rootPath) {
    Object.keys(this.schema).forEach((path) => {
      const interfaces = Object.values(this.schema[path]);
      interfaces.forEach((iface) => {
        bus.export(path, iface);
      })
    });
    bus.export(rootPath, this);
  }
}

class ApplicationInterface extends Interface {

  @property({signature: 'q', access: ACCESS_READ})
  CompanyID = 0x02E5;

  @property({signature: 'q', access: ACCESS_READ})
  ProductID = 0x42;

  @property({signature: 'q', access: ACCESS_READ})
  VersionID = 1;

  @property({signature: 'q', access: ACCESS_READ})
  CRPL = 0x7FFF;

  @method({inSignature: 't'})
  JoinComplete(token) {
    console.log('JoinComplete', token);
  }

  @method({inSignature: 's'})
  JoinFailed(reason) {
    console.log('JoinFailed: ' + reason);
  }
}

class ProvisionerInterface extends Interface {

  @method({inSignature: 'nay'})
  ScanResult(rssi, data) {
    const uuid = bufferToHex(data.slice(0, 16));
    console.log(`Found device with UUID: ${uuid}, RSSI: ${rssi}`);
    sendLog(`Found device with UUID: ${uuid}, RSSI: ${rssi}`);
    if (!management) {
      console.warn('No management object! Ignoring');
      return;
    }

    if (!provisioned[String(uuid)]) {
      console.log('New device! Provisioning...');
      provisioned[String(uuid)] = {
        provisionStartTime: Date.now(),
        rssi,
      };
      (async () => {
        await management.AddNode(data.slice(0, 16))
        console.log('AddNode successfully');
      })().catch((e) => {
        console.error('Could not provision', e);
      })
    }
  }

  @method({inSignature: 'y', outSignature: 'qq'})
  RequestProvData(count) {
    console.log('RequestProvData', count);
    const ret = [0, unicastAddress++];

    console.log('Sending prov data', ret);
    return ret;
  }

  @method({inSignature: 'ayqy'})
  AddNodeComplete(uuid, unicast, count) {
    console.log('AddNodeComplete', uuid, unicast, count, provisioned[uuid]);

    const uuidHex = bufferToHex(uuid.slice(0, 16));
    provisioned[uuidHex] = {
      ...provisioned[uuidHex],
      unicast,
      count,
    }

    configureNode(uuidHex, unicast)
      .catch((error) => {
        console.log('Could not configure node', error);
      })
  }

  @method({inSignature: 'ays'})
  AddNodeFailed(uuid, reason) {
    console.log('AddNodeFailed', uuid, reason);
  }
}

class ProvisionAgentInterface extends Interface {

  @property({signature: 'as', access: ACCESS_READWRITE})
  Capabilities = ['static-oob'];

  @property({signature: 'as', access: ACCESS_READWRITE})
  OutOfBandInfo = ['number'];

  @property({signature: 's', access: ACCESS_READWRITE})
  URI = 'http://someuri';

  @method({outSignature: 'ay'})
  PrivateKey() {
    console.log('PrivateKey');
  }

  @method({outSignature: 'ay'})
  PublicKey() {
    console.log('PublicKey');
  }

  @method({inSignature: 's'})
  DisplayString(value) {
    console.log('DisplayString', value);
  }

  @method({inSignature: 'su'})
  DisplayNumeric(type, number) {
    console.log('DisplayNumeric', type, number);
  }

  @method({inSignature: 's', outSignature: 'u'})
  PromptNumeric(type) {
    console.log('PromptNumeric', type);
    return 12345;
  }

  @method({inSignature: 's', outSignature: 'ay'})
  PromptStatic(type) {
    console.log('PromptStatic', type);
  }

  @method({})
  Cancel() {
    console.log('Cancel');
  }
}

class ElementInterface extends Interface {
  @property({signature: 'y', access: ACCESS_READ})
  Index;

  @property({signature: 'aq', access: ACCESS_READ})
  Models;

  @property({signature: 'a(qq)', access: ACCESS_READ})
  VendorModels;

  // @property({signature: 'q', access: ACCESS_READ})
  // Location;

  @method({inSignature: 'qqvay'})
  MessageReceived(source, key_index, subscription, data) {
    if (source === 0x0001) {
      return;
    }

    if (data.length === 10) {
      try {
        execAckStruct._setBuff(Buffer.from(data));
        const tid = execAckStruct.get('tid');
        const adc = execAckStruct.get('adc');
        console.log('Got ack for task exec with tid:', tid);
        console.log('Measured ADC value: ' + adc);

        fs.appendFile('adc_measurements.csv',
            `${tid},${source},${adc}\n`, (err) => {
              if (err)
                console.warn('Could not log adc value', err);
            })

      } catch (e) {
        console.warn(e);
      }
    }

    if (data.length === 11) {
      try {
        timeBeaconRecvStruct._setBuff(Buffer.from(data))

        const logicTime = timeBeaconRecvStruct.get('logic_time_low') + Number((BigInt(timeBeaconRecvStruct.get('logic_time_high')) << 32n));
        console.log(`Got time from ${source} - time: ${logicTime+20}`);

        sendData('nodeTime', {
          address: source,
          logicTime: logicTime+20,
          recvTime: Date.now(),
        })
      } catch (e) {
        console.log(e);
      }

      return;
    }

    if (data.length === 9) {
      try {
        driftBeaconStructRecv._setBuff(Buffer.from(data));

        let remoteLogicRate = driftBeaconStructRecv.get('logic_rate')/2147483647.0;
        const remoteHardwareTime = driftBeaconStructRecv.get('hardware_time');

        if (!beaconMap[source]) {
          beaconMap[source] = {
            remoteLogicRate,
            remoteHardwareTime,
            localHardwareTime: Date.now(),
            relativeLogicRate: localLogicRate*remoteLogicRate,
            read: false,
          };
          console.log(`Got first drift beacon from node ${source}`);
          return;
        }

        const localHardwareTime = Date.now();

        const remoteHardwareTimeDiff = (remoteHardwareTime - beaconMap[source].remoteHardwareTime) % 65536;
        const localHardwareTimeDiff = localHardwareTime - beaconMap[source].localHardwareTime;
        console.log('remoteHardwareTimeDiff: ', remoteHardwareTimeDiff);

        const current_rate = remoteHardwareTimeDiff / localHardwareTimeDiff;
        console.log('current_rate: ', current_rate);

        let relativeLogicRate = current_rate*remoteLogicRate;
        if (relativeLogicRate > 3.3e-8) {
          relativeLogicRate = 3.3e-8;
        }
        if (relativeLogicRate < -3.3e-8) {
          relativeLogicRate = -3.3e-8;
        }

        beaconMap[source] = {
          remoteLogicRate,
          remoteHardwareTime,
          localHardwareTime,
          relativeLogicRate,
          read: false,
        }
      } catch (e) {
        console.log(e);
      }
    }

    console.log('MessageReceived', source, key_index, subscription, data);
  }

  @method({inSignature: 'qbqay'})
  DevKeyMessageReceived(source, remote, net_index, data) {
    console.log('DevKeyMessageReceived', source, net_index, toHexString(data));
    Object.values(devSendReceiveCallbacks).forEach((callback) => {
      callback(source, remote, net_index, data);
    })
  }

  @method({inSignature: 'q{sv}'})
  UpdateModelConfiguration(model_id, config) {
    console.log('UpdateModelConfiguration', model_id, config);
  }
}

const main = async () => {
  const bus = dbus.systemBus();
  const mainObject = await bus.getProxyObject('org.bluez.mesh', '/org/bluez/mesh');

  network = await mainObject.getInterface('org.bluez.mesh.Network1');

  const app = new ApplicationInterface('org.bluez.mesh.Application1');
  const provisionAgent = new ProvisionAgentInterface('org.bluez.mesh.ProvisionAgent1');
  const provisioner = new ProvisionerInterface('org.bluez.mesh.Provisioner1');

  const element0 = new ElementInterface('org.bluez.mesh.Element1');
  element0.Index = 0;
  element0.Models = [0x1001];
  element0.VendorModels = [[0x02E5, 0x00A1], [0x02E5, 0x00A2], [0x02E5, 0x00A3], [0x02E5, 0x00A4], [0x02E5, 0x00A5], [0x02E5, 0x00A6]];

  const root = new RootInterface('org.freedesktop.DBus.ObjectManager', {
    [`${APP_PATH}`]: [app, provisioner],
    [`${APP_PATH}/agent`]: [provisionAgent],
    [`${APP_PATH}/ele00`]: [element0],
  });

  root.export(bus, APP_PATH);
  console.log('App interfaces exported');

  const uuid = Array.from(Uint8Array.from(randomBytes.sync(16)));
  console.log(uuid);

  token = await network.CreateNetwork(APP_PATH, uuid);

  console.log('CreateNetwork successful, token is', token);
  const uuidHex = bufferToHex(uuid);
  console.log(`Node UUID: ${uuidHex}`)

  console.log('Attaching');
  const attachResult = await network.Attach(APP_PATH, token);
  console.log('Attached', attachResult);


  const nodeObject = await bus.getProxyObject('org.bluez.mesh', `/org/bluez/mesh/node${uuidHex}`);
  management = await nodeObject.getInterface('org.bluez.mesh.Management1');
  node = await nodeObject.getInterface('org.bluez.mesh.Node1')

  console.log('Importing AppKey');
  const superKey = [51, 12, 46, 12, 89, 12, 68, 12,
                    79, 146, 89, 144, 67, 24, 89, 111];

  await management.ImportAppKey(0, 0, superKey);
  console.log('Adding local app key');
  await node.AddAppKey(elementPath, 0x0001, 0, 0, false);

  // await waitForDevReceive((source, key_index, subscription, data) => {
  //   return data[0] === 0x80 && data[1] === 0x3e;
  // });

  console.log('Binding local app key to vendor model');


  // bind tasks model
  const bindStructProxy = bindStruct.fields;

  bindStructProxy.opcode = 0x803D;
  bindStructProxy.element_addr = 0x0001;
  bindStructProxy.model_app_idx = 0x0000;
  bindStructProxy.company_id = 0x02E5;
  bindStructProxy.model_id = 0x00A1;

  await devSendReceive(0x0001, Array.from(bindStruct.buffer()), () => true);

  // bind time sync model

  bindStructProxy.opcode = 0x803D;
  bindStructProxy.element_addr = 0x0001;
  bindStructProxy.model_app_idx = 0x0000;
  bindStructProxy.company_id = 0x02E5;
  bindStructProxy.model_id = 0x00A3;

  await devSendReceive(0x0001, Array.from(bindStruct.buffer()), () => true);

  // bind ota model

  bindStructProxy.opcode = 0x803D;
  bindStructProxy.element_addr = 0x0001;
  bindStructProxy.model_app_idx = 0x0000;
  bindStructProxy.company_id = 0x02E5;
  bindStructProxy.model_id = 0x00A5;

  await devSendReceive(0x0001, Array.from(bindStruct.buffer()), () => true);

  console.log('Bound local AppKey');

  const wss = new WebSocket.Server({ port: 8080 });

  wss.on('connection', (ws) => {
    client = ws;
    ws.on('message', (message) =>  {
      try {
        const data = JSON.parse(message);

        switch (data.id) {
          case 'setTimeBeacon':
            console.log('Setting timeBeaconEnabled to ' + data.enabled);
            timeBeaconEnabled = Boolean(data.enabled);
            break;
          case 'scan':
            console.log('Starting unprovisioned scan');
            management.UnprovisionedScan(5);
            sendLog('Started unprovisioned scan for 5 seconds');
            break;
          case 'nodeDelete':
            console.log('Deleting node with address', data.address);
            management.DeleteRemoteNode(data.address, 1);
            sendLog('Deleted node with address ' + data.address);
            sendData('nodeDeleted', {address: data.address});
            break;
          case 'taskAdd':
            console.log('Enqueuing task', data);

            const enqueueStructProxy = enqueueStruct.fields;

            enqueueStructProxy.opcode = 0xc2;
            enqueueStructProxy.vendor_id = 0x02e5;
            enqueueStructProxy.tid = taskId;
            enqueueStructProxy.func_code = data.funcCode;
            enqueueStructProxy.time = data.timestamp;

            node.Send(elementPath, data.address, 0, Array.from(enqueueStruct.buffer()));
            console.log('Vendor task ENQUEUE sent');
            sendData('taskAdded', {
              timestamp: data.timestamp,
              funcCode: data.funcCode,
              address: data.address,
              taskId,
            });
            taskId++;
            break;
          case 'otaUpdate':
            console.log('Sending OTA update message', data);
            const otaUpdateStructProxy = otaUpdateStruct.fields;
            otaUpdateStructProxy.opcode = 0xc7;
            otaUpdateStructProxy.vendor_id = 0x02e5;

            node.Send(elementPath, data.address, 0, Array.from(otaUpdateStruct.buffer()));
            break;
        }

      } catch (e) {
        console.warn('Could not parse WS message', e);
      }
    });

    // ws.send('something');
  });
};

const onExit = () => {
  if (network) {
    try {
      network.Leave(token);
    } catch (e) {
      console.error('Could not left network', e)
    }
  }
  console.log('Left network');
  process.exit(0);
}

process.once('SIGINT', function (code) {
  console.log('SIGINT received...');
  onExit();
});

process.once('SIGTERM', function (code) {
  console.log('SIGTERM received...');
  onExit();
});

main().then(() => {
}).catch((error) => {
  console.error('An error occurred', error);
  process.exit(1);
});
