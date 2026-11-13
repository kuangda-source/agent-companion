import {usbCommand} from './src/usb-link.ts';
import {test,expect} from 'bun:test';
import {LinkAudio} from './src/link-audio.ts';
import {validAudioPacket,validAudioReply} from '../../packages/protocol/src/audio-wire.ts';
test('audio needs capability and live authenticated view; rejects resolve all in-flight packets',async()=>{
 let live=false;const sent:unknown[]=[],link=new LinkAudio('fixture','a'.repeat(36),p=>sent.push(p),()=>live),signal=new AbortController().signal;
 expect(link.ready()).toBe(false);link.negotiate({audio_protocol:1});expect(link.ready()).toBe(false);live=true;expect(link.ready()).toBe(true);
 const p=link.exchange({kind:'audio_chunk',delivery_id:'d',offset:0,seq:0,crc32:0,data:new Uint8Array(2)},signal);
 expect((sent[0] as Record<string,unknown>).data).toBe('AAA=');link.receive({kind:'audio_reply',delivery_id:'d',state:'rejected',next_offset:0});await expect(p).rejects.toThrow('audio_rejected');link.reset();expect(link.ready()).toBe(false);
});
test('relay audio allowlist bounds frames and forbids management or stale envelopes',()=>{
 const now=Date.now(),p={kind:'audio_chunk',delivery_id:'fixture',gateway_boot_id:crypto.randomUUID(),sent_at:now/1000,seq:0,offset:0,crc32:0,data:'AAA='};
 expect(validAudioPacket(p,now)).toBe(true);expect(validAudioPacket({...p,key:'fixture'},now)).toBe(false);expect(validAudioPacket({...p,kind:'provision'},now)).toBe(false);expect(validAudioPacket({...p,sent_at:(now-16000)/1000},now)).toBe(false);expect(validAudioPacket({...p,data:'A'.repeat(21852)},now)).toBe(false);
 expect(validAudioReply({kind:'audio_reply',delivery_id:'fixture',state:'played',next_offset:100})).toBe(true);expect(validAudioReply({kind:'audio_reply',delivery_id:'fixture',state:'played',next_offset:100,key:'fixture'})).toBe(false);
});

test('USB provisioning stamps current time without modifying or echoing saved credentials',()=>{
 const pending={kind:'link_config',expires_at:1800000000000,request_id:'fixture'},wire=usbCommand(pending,1790000000000);
 expect(wire.sent_at).toBe(1790000000);expect('sent_at' in pending).toBe(false);expect(usbCommand({kind:'audio_cancel'},1790000000000)).toEqual({kind:'audio_cancel'});
});

test('audio follows the last view actually applied by the screen, never a stale transport receipt',async()=>{
 const {DeviceSession}=await import('./src/device-session.ts'),{MockState}=await import('./src/scenarios.ts'),{SettingsStore}=await import('./src/settings.ts');const state=new MockState(),settings=new SettingsStore(),usb=new DeviceSession(state,settings,undefined,'usb'),relay=new DeviceSession(state,settings,undefined,'relay');
 // Shared view sequence orders delayed receipts even during a USB/network switch.
 relay.sent(1);usb.sent(2);relay.acknowledge({gateway_boot_id:relay.boot,id:1});expect(relay.ownsDisplay()).toBe(true);usb.acknowledge({gateway_boot_id:usb.boot,id:2});expect(usb.ownsDisplay()).toBe(true);expect(relay.ownsDisplay()).toBe(false);
 relay.sent(3);relay.acknowledge({gateway_boot_id:relay.boot,id:3});expect(relay.ownsDisplay()).toBe(true);expect(usb.ownsDisplay()).toBe(false);
 usb.sent(2);usb.acknowledge({gateway_boot_id:usb.boot,id:2});expect(relay.ownsDisplay()).toBe(true);
});

test('cancel waits for the real device reply instead of manufacturing an immediate acknowledgement',async()=>{
 const link=new LinkAudio('fixture','a'.repeat(36),()=>{},()=>true);link.negotiate({audio_protocol:1});let settled=false;const pending=link.exchange({kind:'audio_cancel',delivery_id:'fixture'},new AbortController().signal).then(()=>settled=true);await Bun.sleep(5);expect(settled).toBe(false);link.receive({kind:'audio_reply',delivery_id:'fixture',state:'rejected',next_offset:0});await pending;expect(settled).toBe(true);
});
