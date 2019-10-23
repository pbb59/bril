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
    'vsub' : { 'scalar_inst' : 'sub', 'arg_map' : { 0 : 0, 1 : 1 }},
    'vmul' : { 'scalar_inst' : 'mul', 'arg_map' : { 0 : 0, 1 : 1 }},
    'vdiv' : { 'scalar_inst' : 'div', 'arg_map' : { 0 : 0, 1 : 1 }},
    'gather' : { 'scalar_inst' : 'lw', 'arg_map' : { 0 : 0 }},
    'scatter' : { 'scalar_inst' : 'sw', 'arg_map' : { 0 : 0, 1 : 1 }},
    'v2s'  : { 'scalar_inst' : 'id' , 'arg_map' : { 0 : 0 }},
    's2vb' : { 'scalar_inst' : 'id' , 'arg_map' : { 0 : 0 }},
    's2v'  : { 'scalar_inst' : 'id' , 'arg_map' : { 0 : 0 }}
}

# denote where vector args should be
vector_ops = {
    'vadd' : { 'vec_args' : [ 0, 1 ] },
    'vsub' : { 'vec_args' : [ 0, 1 ] },
    'vmul' : { 'vec_args' : [ 0, 1 ] },
    'vdiv' : { 'vec_args' : [ 0, 1 ] },
    'v2s'  : { 'vec_args' : [ 0 ] },
    'vphi' : { 'vec_args' : [ 1, 2 ] },
    'vcmp' : { 'vec_args' : [ 0, 1 ] }
}

# ASSUMES SSA
# update arguments names to a new value from after a certain point following program order
def update_names(func, from_, to_, to_vector = False, start = 0):
    for i in range(start, len(func['instrs'])):
        instr = func['instrs'][i]
        args = var_args(instr)
        for i in range(len(args)):
            if args[i] == from_:
                if (to_vector):
                    if (instr['op'] in vector_ops):
                        if (i in vector_ops[instr['op']]['vec_args']):
                            instr['args'][i] = to_
                else:
                    instr['args'][i] = to_

# after instruction swap there may be type mismatch where use scalars as vector arguments
# solve this by doing a pass that inserts s2vb instructions before they are used in vector instructions
def restich_pass(func):
    i = 0
    for instr in func['instrs']:
        #instr = func['instrs'][i]
        # check if vector instruction has vector args
        if 'op' in instr and instr['op'] in vector_ops:
            
            # foreach arg check if it is a vector op
            args = var_args(instr)
            for j in range(len(args)):
                if not j in vector_ops[instr['op']]['vec_args']:
                    continue
                arg = args[j]
                # just do brute lookup
                okay = True
                for inst in func['instrs']:
                    if 'dest' in inst and inst['dest'] == arg:
                        if (inst['type'] != 'vector'):
                            okay = False
                        break

                # insert a s2vb before the failing instruction
                if (not okay):
                    new_arg = arg + '_v'
                    new_inst = {
                        'dest' : new_arg,
                        'op'   : 's2vb',
                        'args' : [arg],
                        'type' : 'vector'
                    }
                    
                    # need to update the argument of this instruction to change name
                    # and all future instructions that use that name
                    update_names(func, arg, new_arg, True, i)

                    func['instrs'].insert(i, new_inst)
        i += 1

                    

                    

def perform_swap(todo_instr, func):
    # find the instruction to modify, needs SSA
    for prog_instr in func['instrs']:
        if 'dest' in prog_instr and todo_instr['dest'] == prog_instr['dest']:
            # python defaults to pass by ref
            instr = prog_instr

    if instr['op'] in swap_table:

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

        # if the vector instruction is predicated, we can still convert the instruction to scalar
        # as long as remerge the scalars into a single vector using s2vb and vphi/merge with predicate (done in reglue pass above)
        # you can also remove the predicates from the scalars
        # helpful discussions with vector-master Khalid Al-Hawaj.
        if 'pred' in instr:
            pred = instr['pred']
            instr['pred'] = 'undefined'
            instr['neg']  = 'undefined'

        # annonate the name to show that it was changed
        if (old_type != 'vector'):
            return
        
        old_name = instr['dest']
        instr['dest'] += '_s'
        
        # update any dependencies in program order after the swap (change name), needs SSA
        update_names(func, old_name, instr['dest'], False)
        
    

def reduce_vector_pass(func):
    """Peephole optimizations to swap in more efficient instructions based on divergence instruction
        Should be in SSA form?
    """
    
    # do divergence analysis on the function
    # NOTE blocks contain only a single instruction and optional label
    blocks, in_, out = div_analysis(func)

    # based on divergence analysis of each instruction perform instruction swap to scalar when not divergent
    # we also want to mark each variable that was changed with a name annotation and change type
    # propagate that to the uses
    for label, block in blocks.items():
        div_insts = out[label]

        # check if the instructions is divergent, if not try to replace with cheaper inst
        for instr in block:
            # in ssa, an instruction and dest are the same
            if 'dest' in instr and not instr['dest'] in div_insts:
                perform_swap(instr, func)


def reduce_vector(func):
    """The divergence optimizations requires two passes
        1) Swap out instructions of non-divergent vector ops
        2) Regenerate some vector ops if the newly generated scalar is needed for a vector op later
    """
    
    reduce_vector_pass(func)
    restich_pass(func)

def localopt():
    # Apply the change to all the functions in the input program.
    bril = json.load(sys.stdin)
    for func in bril['functions']:
        reduce_vector(func)
    json.dump(bril, sys.stdout, indent=2, sort_keys=True)


if __name__ == '__main__':
    localopt()
