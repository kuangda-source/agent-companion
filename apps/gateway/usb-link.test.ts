import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {USBLink,usbFrame} from './src/usb-link.ts';
import {connectionState} from './src/connection-state.ts';
import {RemoteLink} from './src/remote-link.ts';
import {SettingsStore} from './src/settings.ts';
import {MockState} from './src/scenarios.ts';
import {Assistant} from './src/assistant.ts';
import type {Collector} from './src/state.ts';

async function until(check:()=>boolean){const limit=Date.now()+10000;while(!check()){if(Date.now()>limit)throw new Error('USB fixture timeout');await Bun.sleep(30);}}
test('USB is the new-install default; explicitly chosen wireless settings persist',()=>{
 const root=mkdtempSync(join(tmpdir(),'ac-usb-settings-'));try{const file=join(root,'settings.json'),settings=new SettingsStore(file);expect(settings.current().device.transport).toBe('usb');settings.update({device:{transport:'wifi'}});expect(new SettingsStore(file).current().device.transport).toBe('wifi');}finally{rmSync(root,{recursive:true,force:true});}
});
test('USB frames use the device CRC32 protocol and enforce the firmware size bound',()=>{
 const value={kind:'detail',id:'示例'},frame=usbFrame(value),end=frame.indexOf(10),header=frame.subarray(0,end).toString().split(' '),body=frame.subarray(end+1,-1);
 expect(Number(header[1])).toBe(body.length);expect(header[2]).toBe(Bun.hash.crc32(body).toString(16).padStart(8,'0'));expect(JSON.parse(body.toString())).toEqual(value);
 expect(()=>usbFrame({text:'x'.repeat(192*1024)})).toThrow('usb_frame_size');
});
test('only fresh USB view acknowledgements select USB; provisioning and cable presence alone do not',()=>{
 const remote={data_fresh:false,device_connected:false,last_applied_at:null,last_applied_id:0,usb:{mode:'usb_viewer',data_fresh:false}},lan={data_fresh:true,device_connected:true,last_applied_at:'now',last_applied_id:8};
 expect(connectionState(remote,lan).active_transport).toBe('wifi');remote.usb.data_fresh=true;
 expect(connectionState(remote,lan)).toMatchObject({active_transport:'usb',data_fresh:true});remote.usb.mode='network_only';expect(connectionState(remote,lan).active_transport).toBe('wifi');
 remote.usb.mode='usb_viewer';remote.usb.data_fresh=false;expect(connectionState(remote).active_transport).toBeNull();
});
test('native-helper fixture carries views, screen commands, display ACKs and provisioning; a closed port clears USB health',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ac-usb-link-')),helper=join(root,'helper');
 // A synthetic subprocess replaces all hardware. No local Agent records or ports.
 writeFileSync(helper,`#!${process.execPath}\nif(process.argv.includes('--list')){console.log('/dev/cu.usbmodemMOCK');process.exit(0);}
 console.log('AC_EVT {"kind":"ready","version":"V1-board-MOCK"}');
 let buffer=Buffer.alloc(0);for await(const chunk of Bun.stdin.stream()){buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf(10);if(end<0)break;const h=buffer.subarray(0,end).toString().split(' '),n=Number(h[1]);if(buffer.length<end+1+n+1)break;const body=buffer.subarray(end+1,end+1+n);buffer=buffer.subarray(end+1+n+1);if(Bun.hash.crc32(body).toString(16).padStart(8,'0')!==h[2])process.exit(9);const v=JSON.parse(body.toString());if(v.kind==='provision'){console.log('AC_PROVISION '+JSON.stringify({request_id:v.request_id,state:'saved'}));continue;}if(v.state){console.log('AC_DISPLAY '+JSON.stringify(v.settings.display));console.log('AC_ACK '+v.id+' seq='+v.state.seq);console.log('AC_EVT {"kind":"theme","value":"comic"}');}}}
 `);chmodSync(helper,0o700);
 const mock=new MockState(),settings=new SettingsStore(),collector={current:()=>({...mock.current(),data_source:'live',generated_at:new Date().toISOString()}),detail:(id:string)=>mock.detail(id)} as Collector;
 const assistant=new Assistant(mock,root,async()=>{throw new Error('unexpected API call');});
 const pending=join(root,'wifi-pending.json');writeFileSync(pending,JSON.stringify({kind:'provision',request_id:'mock',expires_at:Date.now()+60000,ssid:'Mock only',password:'mock-password'}));
 const usb=new USBLink(root,collector,settings,assistant,helper),remote=new RemoteLink(root,collector,settings,assistant,{tickMs:60000});
 try{
  await until(()=>existsSync(join(root,'board-bridge.status.json'))&&connectionState(remote.status()).active_transport==='usb');
  expect(settings.current().appearance.theme).toBe('comic');expect(existsSync(pending)).toBe(false);
  expect(remote.status().usb?.last_ack).toBeGreaterThan(0);expect(remote.status().usb?.display).toBeTruthy();
  usb.close();await until(()=>JSON.parse(readFileSync(join(root,'board-bridge.status.json'),'utf8')).usb_connected===false);
  expect(connectionState(remote.status()).active_transport).toBeNull();
 }finally{usb.close();remote.close();await assistant.shutdown();rmSync(root,{recursive:true,force:true});}
});
