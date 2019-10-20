"""Reduce the amount of vector instructions based on divergence analysis
"""

import sys
import json
from form_blocks import form_blocks
from util import flatten, var_args
from df import div_analysis

# DONT PUT PRINTS OTHERWISE PIPE TO BRIL2TXT WONT WORK!!

# specifies which vector instructions should be swapped and how arguments should be mapped
swap_table = {
    'vadd' : { 'scalar_inst' : 'add', 'arg_map' : { 0 : 0, 1 : 1 }},
    'v2s'  : { 'scalar_inst' : 'id' , 'arg_map' : { 0 : 0 }},
    's2vb' : { 'scalar_inst' : 'id' , 'arg_map' : { 0 : 0 }},
    's2v'  : { 'scalar_inst' : 'id' , 'arg_map' : { 0 : 0 }}
}

def perform_swap(todo_instr, func):
    # find the instruction to modify, needs SSA
    for prog_instr in func['instrs']:
        if 'dest' in prog_instr and todo_instr['dest'] == prog_instr['dest']:
            # python defaults to pass by ref
            instr = prog_instr

    if instr['op'] in swap_table:
        #print(instr) 
        
        # exchange arguments
        args = var_args(instr)
        instr['args'] = []
        map = swap_table[instr['op']]['arg_map']
        for i in range(len(map)):
            instr['args'].append('')
        for i in range(len(args)):
            if i in map:
                instr['args'][map[i]] = args[i]

        # perform the op swap
        instr['op'] = swap_table[instr['op']]['scalar_inst']

        # update the type of instructions
        # for now always vector,int -> int
        old_type = instr['type']
        instr['type'] = 'int'

        # annonate the name to show that it was changed
        if (old_type != 'vector'):
            return
        
        old_name = instr['dest']
        instr['dest'] += '_s'
        
        # update any dependencies in program order after the swap (change name), needs SSA
        for dep_inst in func['instrs']:
            args = var_args(dep_inst)
            for i in range(len(args)):
                if args[i] == old_name:
                    dep_inst['args'][i] = instr['dest']
        
    

def reduce_vector_pass(func):
    """Peephole optimizations to swap in more efficient instructions based on divergence instruction
        Should be in SSA form?
    """
    
    # do divergence analysis on the function
    # TODO current being done at block level, want at inst level!
    blocks, in_, out = div_analysis(func)
    #blocks = list(form_blocks(func['instrs']))
    # for each of the blocks(!) look at all of the variables that don't have
    # an out divergence and attempt to optimize the single instructions
    # we also want to mark each variable that was changed with a name annotation and change type
    # propagate that to the uses
    
    for label, block in blocks.items():
        div_insts = out[label]

        # check if the instructions is divergent, if not try to replace with cheaper inst
        for instr in block:
            # in ssa, an instruction and dest are the same
            if 'dest' in instr and not instr['dest'] in div_insts:
                perform_swap(instr, func)

    # Reassemble the function.
    #func['instrs'] = flatten(blocks.values())
    
    changed = False
    return changed

def reduce_vector(func):
    """Iteratively optimize using divergence analysis, stopping when nothing
    remains to remove.
    """
    
    while reduce_vector_pass(func):
        pass

'''
MODES = {
    'tdce': trivial_dce,
    'tdcep': trivial_dce_pass,
    'dkp': drop_killed_pass,
    'tdce+': trivial_dce_plus,
}
'''

def localopt():
    if len(sys.argv) > 1:
        #modify_func = MODES[sys.argv[1]]
        assert(False)
    else:
        modify_func = reduce_vector

    # Apply the change to all the functions in the input program.
    bril = json.load(sys.stdin)
    for func in bril['functions']:
        modify_func(func)
    json.dump(bril, sys.stdout, indent=2, sort_keys=True)


if __name__ == '__main__':
    localopt()
