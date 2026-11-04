/* Native macOS byte transport. Business data and credentials stay in Gateway. */
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/serial/IOSerialKeys.h>
#include <IOKit/serial/ioss.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/file.h>
#include <termios.h>
#include <unistd.h>

static volatile sig_atomic_t stopped;
static void stop(int sig) { (void)sig; stopped=1; }
static int number(io_registry_entry_t entry,const char *key) {
    CFStringRef name=CFStringCreateWithCString(NULL,key,kCFStringEncodingUTF8);
    CFTypeRef value=IORegistryEntryCreateCFProperty(entry,name,NULL,0);CFRelease(name);
    int result=-1;
    if(value&&CFGetTypeID(value)==CFNumberGetTypeID())CFNumberGetValue(value,kCFNumberIntType,&result);
    if(value)CFRelease(value);return result;
}
static int list(void) {
    io_iterator_t iterator=0;
    if(IOServiceGetMatchingServices(kIOMainPortDefault,IOServiceMatching(kIOSerialBSDServiceValue),&iterator)!=KERN_SUCCESS)return 1;
    io_object_t service;
    while((service=IOIteratorNext(iterator))) {
        io_registry_entry_t parent=service;IOObjectRetain(parent);int matched=0;
        for(unsigned depth=0;depth<12;depth++) {
            if(number(parent,"idVendor")==0x303a&&number(parent,"idProduct")==0x1001){matched=1;break;}
            io_registry_entry_t next=0;
            if(IORegistryEntryGetParentEntry(parent,kIOServicePlane,&next)!=KERN_SUCCESS)break;
            IOObjectRelease(parent);parent=next;
        }
        IOObjectRelease(parent);
        if(matched) {
            CFTypeRef value=IORegistryEntryCreateCFProperty(service,CFSTR(kIOCalloutDeviceKey),NULL,0);
            char path[1024];
            if(value&&CFGetTypeID(value)==CFStringGetTypeID()&&CFStringGetCString(value,path,sizeof(path),kCFStringEncodingUTF8)&&!strncmp(path,"/dev/cu.usbmodem",16))puts(path);
            if(value)CFRelease(value);
        }
        IOObjectRelease(service);
    }
    IOObjectRelease(iterator);return 0;
}
static int transfer(int fd,const char *data,size_t size) {
    while(size&&!stopped) {
        ssize_t n=write(fd,data,size);
        if(n>0){data+=n;size-=(size_t)n;continue;}
        if(n<0&&(errno==EAGAIN||errno==EINTR)){struct pollfd p={fd,POLLOUT,0};if(poll(&p,1,1000)>=0)continue;}
        return 0;
    }
    return size==0;
}
int main(int argc,char **argv) {
    if(argc==2&&!strcmp(argv[1],"--list"))return list();
    if(argc!=3||strcmp(argv[1],"--port")||strncmp(argv[2],"/dev/cu.usbmodem",16))return 2;
    signal(SIGTERM,stop);signal(SIGINT,stop);signal(SIGPIPE,stop);
    int fd=open(argv[2],O_RDWR|O_NOCTTY|O_NONBLOCK);if(fd<0)return 3;
    if(flock(fd,LOCK_EX|LOCK_NB)<0||ioctl(fd,TIOCEXCL)<0){close(fd);return 4;}
    struct termios options;
    if(tcgetattr(fd,&options)<0){close(fd);return 5;}
    cfmakeraw(&options);options.c_cflag|=CLOCAL|CREAD;options.c_cflag&=~(CSTOPB|PARENB|CSIZE|CRTSCTS);options.c_cflag|=CS8;
    cfsetispeed(&options,B115200);cfsetospeed(&options,B115200);
    if(tcsetattr(fd,TCSANOW,&options)<0){close(fd);return 6;}
    speed_t speed=921600;if(ioctl(fd,IOSSIOSPEED,&speed)<0){close(fd);return 7;}
    int lines=TIOCM_DTR|TIOCM_RTS;ioctl(fd,TIOCMBIC,&lines);
    while(!stopped) {
        struct pollfd fds[2]={{STDIN_FILENO,POLLIN,0},{fd,POLLIN,0}};
        int ready=poll(fds,2,250);if(ready<0){if(errno==EINTR)continue;break;}
        if(fds[0].revents&(POLLHUP|POLLERR|POLLNVAL)||fds[1].revents&(POLLHUP|POLLERR|POLLNVAL))break;
        char bytes[8192];
        for(unsigned i=0;i<2;i++)if(fds[i].revents&POLLIN) {
            ssize_t n=read(fds[i].fd,bytes,sizeof(bytes));
            if(n>0){if(!transfer(i==0?fd:STDOUT_FILENO,bytes,(size_t)n))stopped=1;}
            else if(n==0||(errno!=EAGAIN&&errno!=EINTR))stopped=1;
        }
    }
    close(fd);return 0;
}
