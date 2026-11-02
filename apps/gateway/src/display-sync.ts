/** Host display observation and bounded backlight commands; no host display writes. */
import type { Settings } from './settings.ts';
export interface HostDisplay { display_id:number; display_name:string; brightness_ratio:number|null; screen_awake:boolean; observed_at:string }
export interface DisplayCommand { revision:number; brightness_percent:number; screen_on:boolean }
interface AppliedDisplay extends DisplayCommand {backlight_duty:number; observed_at:string}
export class DisplaySync {
 private host:HostDisplay|null=null;private seen=0;private revision=0;private key='';private applied:AppliedDisplay|null=null;
 constructor(private clock=()=>performance.now()){}
 observe(input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('invalid_host_display');
  const o=input as Record<string,unknown>;
  if(Object.keys(o).some(k=>!['display_id','display_name','brightness_ratio','screen_awake','observed_at'].includes(k))||!Number.isSafeInteger(o.display_id)||Number(o.display_id)<0||typeof o.display_name!=='string'||o.display_name.length>80||typeof o.screen_awake!=='boolean'||!(o.brightness_ratio===null||typeof o.brightness_ratio==='number'&&Number.isFinite(o.brightness_ratio)&&o.brightness_ratio>=0&&o.brightness_ratio<=1)||typeof o.observed_at!=='string'||!Number.isFinite(Date.parse(o.observed_at))||Math.abs(Date.now()-Date.parse(o.observed_at))>10000)throw new Error('invalid_host_display');
  this.host={display_id:Number(o.display_id),display_name:o.display_name,brightness_ratio:o.brightness_ratio as number|null,screen_awake:o.screen_awake,observed_at:o.observed_at};this.seen=this.clock();
 }
 command(device:Settings['device']):DisplayCommand {
  const fresh=!!this.host&&this.clock()-this.seen<15000;
  const brightness=device.follow_host_brightness&&fresh&&this.host?.brightness_ratio!==null?Math.round(this.host!.brightness_ratio!*100):device.brightness;
  // A last confirmed sleep stays dark through system sleep/network loss, until an explicit wake.
  const on=!(device.follow_host_sleep&&this.host?.screen_awake===false);
  const key=brightness+':'+on;if(key!==this.key){this.key=key;this.revision++;}
  return {revision:this.revision,brightness_percent:brightness,screen_on:on};
 }
 acknowledge(expected:DisplayCommand,input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))return;
  const o=input as Record<string,unknown>,duty=Math.floor(1023*(expected.screen_on?expected.brightness_percent:0)/100);
  if(o.revision!==expected.revision||o.brightness_percent!==expected.brightness_percent||o.screen_on!==expected.screen_on||o.backlight_duty!==duty)return;
  this.applied={...expected,backlight_duty:duty,observed_at:new Date().toISOString()};
 }
 status(device:Settings['device']){
  const target=this.command(device),fresh=!!this.host&&this.clock()-this.seen<15000,a=this.applied;
  return {host:this.host,host_fresh:fresh,brightness_available:fresh&&this.host?.brightness_ratio!==null,target,applied:a,in_sync:!!a&&a.revision===target.revision&&Date.now()-Date.parse(a.observed_at)<8000};
 }
}
