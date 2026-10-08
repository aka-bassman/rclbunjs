// glibc main-arena bytes in use; allocations made on the JS thread land there.
#include <malloc.h>
#include <stdint.h>
uint64_t native_in_use(void) {
  struct mallinfo2 m = mallinfo2();
  return (uint64_t)(m.uordblks + m.hblkhd);
}
