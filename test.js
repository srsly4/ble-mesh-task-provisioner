const dbus = require('dbus-next');
const prompts = require('prompts');
const randomBytes = require('random-bytes');
const {
  Interface, property, method, signal, DBusError,
  ACCESS_READ, ACCESS_WRITE, ACCESS_READWRITE
} = dbus.interface;

let unicastAddress = 0x0010;

let management;
const provisioned = {};

function bufferToHex(buffer, length=16) {
  return [...new Uint8Array (buffer)]
    .map (b => b.toString(length).padStart (2, "0"))
    .join ("");
}

// dbus.setBigIntCompat(true);
const APP_PATH = '/com/sp/jsprov';

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
  CompanyID = 0x0EE5;

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
    if (!management) {
      console.warn('No management object! Ignoring');
      return;
    }

    if (!provisioned[uuid]) {
      console.log('New device! Provisioning...');
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
    console.log('AddNodeComplete', uuid, unicast, count);
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

  @method({inSignature: 'qqbay'})
  MessageReceived(source, key_index, subscription, data) {
    console.log('MessageReceived', source, key_index, subscription, data);
  }

  @method({inSignature: 'qqay'})
  DevKeyMessageReceived(source, net_index, data) {
    console.log('DevKeyMessageReceived', source ,net_index, data);
  }

  @method({inSignature: 'q{sv}'})
  UpdateModelConfiguration(model_id, config) {
    console.log('UpdateModelConfiguration', model_id, config);
  }
}

const main = async () => {
  const bus = dbus.systemBus();
  const mainObject = await bus.getProxyObject('org.bluez.mesh', '/org/bluez/mesh');

  const network = await mainObject.getInterface('org.bluez.mesh.Network1');

  const app = new ApplicationInterface('org.bluez.mesh.Application1');
  const provisionAgent = new ProvisionAgentInterface('org.bluez.mesh.ProvisionAgent1');
  const provisioner = new ProvisionerInterface('org.bluez.mesh.Provisioner1');

  const element0 = new ElementInterface('org.bluez.mesh.Element1');
  element0.Index = 0;
  element0.Models = [0x0001];
  element0.VendorModels = [];

  const root = new RootInterface('org.freedesktop.DBus.ObjectManager', {
    [`${APP_PATH}`]: [app, provisioner],
    [`${APP_PATH}/agent`]: [provisionAgent],
    [`${APP_PATH}/ele00`]: [element0],
  });

  root.export(bus, APP_PATH);
  console.log('App interfaces exported');

  const uuid = Array.from(Uint8Array.from(randomBytes.sync(16)));
  console.log(uuid);

  const token = await network.CreateNetwork(APP_PATH, uuid);

  console.log('CreateNetwork successfull, token is', token);
  const uuidHex = bufferToHex(uuid);
  console.log(`Node UUID: ${uuidHex}`)

  console.log('Attaching');
  const attachResult = await network.Attach(APP_PATH, token);
  console.log('Attached', attachResult);


  const nodeObject = await bus.getProxyObject('org.bluez.mesh', `/org/bluez/mesh/node${uuidHex}`);
  management = await nodeObject.getInterface('org.bluez.mesh.Management1');

  console.log('Starting unprovisioned scan');
  await management.UnprovisionedScan(5);

  await prompts({
    type: 'text',
    name: 'meaning',
    message: 'Type anything to left the network'
  });


  await network.Leave(token);
  console.log('Left network');
};

main().then(() => {
  console.log('App ended');
  process.exit(0);
}).catch((error) => {
  console.error('An error occurred', error);
  process.exit(1);
});
