import {test,expect} from 'bun:test';
import {DisplaySync} from './src/display-sync.ts';
import {SettingsStore} from './src/settings.ts';
const sample=(awake=true,brightness:number|null=.6)=>({display_id:1,display_name:'Test main display',brightness_ratio:brightness,screen_awake:awake,observed_at:new Date().toISOString()});
test('host brightness, sleep/wake, manual overrides and unavailable/stale readings preserve explicit power intent',()=>{
 let now=0;const sync=new DisplaySync(()=>now),device=new SettingsStore().current().device;
 expect(sync.command(device)).toMatchObject({brightness_percent:75,screen_on:true});
 sync.observe(sample());const on=sync.command(device);expect(on).toMatchObject({brightness_percent:60,screen_on:true});
 sync.observe(sample());expect(sync.command(device).revision).toBe(on.revision);
 sync.observe(sample(false));expect(sync.command(device).screen_on).toBe(false);
 now=20000;expect(sync.command(device)).toMatchObject({brightness_percent:75,screen_on:false});expect(sync.status(device).host_fresh).toBe(false);
 expect(sync.command({...device,follow_host_sleep:false}).screen_on).toBe(true);
 sync.observe(sample());expect(sync.command(device)).toMatchObject({brightness_percent:60,screen_on:true});
 expect(sync.command({...device,follow_host_brightness:false,brightness:35})).toMatchObject({brightness_percent:35,screen_on:true});
 sync.observe(sample(true,null));expect(sync.command(device).brightness_percent).toBe(75);expect(sync.status(device).brightness_available).toBe(false);
 sync.observe(sample(true,0));expect(sync.command(device).brightness_percent).toBe(0);
 for(const value of [{...sample(),brightness_ratio:2},{...sample(),screen_awake:0},{...sample(),observed_at:'2000-01-01T00:00:00Z'},{...sample(),execute:'forbidden'}])expect(()=>sync.observe(value)).toThrow();
});
test('a view ACK alone or a mismatching PWM readback cannot confirm brightness applied',()=>{
 const sync=new DisplaySync(),device=new SettingsStore().current().device;sync.observe(sample());const command=sync.command(device);
 sync.acknowledge(command,undefined);expect(sync.status(device).in_sync).toBe(false);
 sync.acknowledge(command,{...command,backlight_duty:1023});expect(sync.status(device).in_sync).toBe(false);
 sync.acknowledge(command,{...command,backlight_duty:613});expect(sync.status(device).in_sync).toBe(true);
 sync.observe(sample(false));const off=sync.command(device);expect(sync.status(device).in_sync).toBe(false);
 sync.acknowledge(off,{...off,backlight_duty:613});expect(sync.status(device).in_sync).toBe(false);
 sync.acknowledge(off,{...off,backlight_duty:0});expect(sync.status(device).in_sync).toBe(true);
});
