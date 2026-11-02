#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <assert.h>
uint32_t lv_rle_decompress(const uint8_t*,uint32_t,uint8_t*,uint32_t,uint8_t);
void *lv_malloc(size_t size){return malloc(size);}
static uint8_t *read(const char *path,size_t *size){FILE *f=fopen(path,"rb");assert(f);fseek(f,0,SEEK_END);*size=ftell(f);rewind(f);uint8_t *p=malloc(*size);assert(p&&fread(p,1,*size,f)==*size);fclose(f);return p;}
int main(int argc,char **argv){assert(argc>1);for(int i=1;i<argc;++i){char path[2048];size_t nr,np;snprintf(path,sizeof(path),"%s.raw",argv[i]);uint8_t *raw=read(path,&nr);snprintf(path,sizeof(path),"%s.rle",argv[i]);uint8_t *packed=read(path,&np),*out=malloc(nr);assert(out);assert(lv_rle_decompress(packed,np,out,nr,2)==nr);assert(!memcmp(raw,out,nr));free(raw);free(packed);free(out);}printf("PASS native LVGL RLE: %d images decoded byte-exact\n",argc-1);return 0;}
