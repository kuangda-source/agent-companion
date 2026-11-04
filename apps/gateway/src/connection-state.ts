/** A cable or socket alone does not establish that the screen applied a view. */
interface AppliedLink {device_connected:boolean;data_fresh:boolean;last_applied_at:string|null;last_applied_id?:number}
export function connectionState<R extends AppliedLink & {usb?:Record<string,unknown>|null}>(remote:R,lan?:AppliedLink){
 const usb=remote.usb,usbFresh=usb?.mode==='usb_viewer'&&usb.data_fresh===true;
 const transport=usbFresh?'usb':lan?.data_fresh?'wifi':remote.data_fresh?'relay':null;
 return {...remote,lan,relay_device_connected:remote.device_connected,
  device_connected:usbFresh||remote.device_connected||!!lan?.device_connected,
  data_fresh:usbFresh||remote.data_fresh||!!lan?.data_fresh,active_transport:transport,
  last_applied_at:usbFresh?usb.last_ack_utc:lan?.data_fresh?lan.last_applied_at:remote.last_applied_at,
  last_applied_id:usbFresh?usb.last_ack:lan?.data_fresh?lan.last_applied_id:remote.last_applied_id};
}
