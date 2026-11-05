/* Linux user-mode environment for riscv-tests (AgentVM JIT testing).
   Pass: exit(0). Fail: exit(test number). */
#ifndef _ENV_LINUX_USER_H
#define _ENV_LINUX_USER_H
#define RVTEST_RV64U .macro init; .endm
#define RVTEST_RV32U .macro init; .endm
#define RVTEST_RV64UF .macro init; .endm
#define RVTEST_RV64UV .macro init; .endm
#define TESTNUM gp
#define RVTEST_CODE_BEGIN .text; .globl _start; _start: init;
#define RVTEST_CODE_END unimp
#define RVTEST_PASS li a0, 0; li a7, 93; ecall
#define RVTEST_FAIL mv a0, TESTNUM; li a7, 93; ecall
#define EXTRA_DATA
#define RVTEST_DATA_BEGIN EXTRA_DATA .align 4; .global begin_signature; begin_signature:
#define RVTEST_DATA_END .align 4; .global end_signature; end_signature:
#endif
